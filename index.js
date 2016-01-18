"use strict";

const Promise = require('bluebird');
const fs = require('fs');
const resolve = require('path').resolve;
const logger = require('winston');
const cheerio = require('cheerio');
const request = require('request-promise');
const CookieStore = require('tough-cookie-filestore');

const Downloads = require('./lib/downloads');

/**
 * Initializes the library.
 *
 * @param {string} name Name of the board
 * @param {string} url URL of the board, without /index.php
 * @param {string} [username] Username
 * @param {string} [password] Password
 * @constructor
 */
const IPS = function IPS(name, url, username, password) {

	this._name = name;
	this._url = url.replace(/\/$/, '');;
	this._username = username;
	this._password = password;
	this._prefix = name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

	this._cache = resolve(process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'], '.ipslib');
	if (!fs.existsSync(this._cache)) {
		fs.mkdirSync(this._cache)
	}
	this._cookieJar = request.jar(new CookieStore(resolve(this._cache, this._prefix + '-cookies.json')));

	// sub-modules
	this.downloads = new Downloads(this);

	//require('request-debug')(request);
};

/**
 * Performs a GET request to the provided URL path, as anonymous.
 * @param url Complete URL or path
 * @returns Promise<T.Cheerio> Parsed HTML body
 * @private
 */
IPS.prototype._get = function(url) {
	const config = {
		uri: url[0] === '/' ? this._url + url : url,
		transform: function(body) {
			return cheerio.load(body);
		},
		jar: false
	};
	logger.info('--> GET %s', config.uri);
	return request(config);
};

/**
 * Performs a GET request to the provided URL path, with the current session, if logged.
 * @param url Complete URL or path
 * @returns Promise<T.Cheerio> Parsed HTML body
 * @private
 */
IPS.prototype._getAuthenticated = function(url) {
	const config = {
		uri: url[0] === '/' ? this._url + url : url,
		transform: function(body) {
			return cheerio.load(body);
		},
		jar: this._cookieJar
	};
	logger.info('--> GET %s (authenticated)', config.uri);
	return request(config);
};

/**
 * Closes a session.
 *
 * Note that this must be called explictly, otherwise the session stays open
 * even across restarts.
 * @returns {Promise}
 */
IPS.prototype.logout = function() {
	return Promise.try(() => {
		// fetch another damn id
		logger.info('--> GET %s', this._url + '/index.php');
		return request({ uri: this._url + '/index.php', jar: this._cookieJar });

	}).then(body => {
		var m;
		if (m = body.match(/<a\shref="([^"]+do=logout[^"]+)/)) {
			let uri = decodeURI(m[1]).replace(/&amp;/gi, '&');
			logger.info('--> GET %s', uri);
			return request({ uri: uri, jar: this._cookieJar }).then(body => {
				if (new RegExp('>' + this._username + ' &nbsp;', 'i').test(body)) {
					throw new Error('Logout failed.');
				}
				logger.info('Logout successful.');
			});

		} else {
			logger.warn('Looks like you are not logged in anyway, aborting.');
		}
	});
};


/**
 * Logs the user in.
 *
 * Run this before accessing protected URLs and make sure you use
 * {@link _getAuthenticated()} after that.
 *
 * @returns {Promise}
 * @private
 */
IPS.prototype._login = function() {

	return Promise.try(() => {
		if (!this._username || !this._password) {
			throw new Error('Need valid credentials for this action. Instantiate Ips with username and password.');
		}
		logger.info('--> GET %s', this._url + '/');
		return request({ uri: this._url + '/', jar: this._cookieJar });

	}).then(body => {

		if (new RegExp('>' + this._username + ' &nbsp;', 'i').test(body)) {
			logger.info("User already logged, skipping login.");
			return;
		}

		// get whatever the fuck this auth key is...
		var key = body.match(/<input\s+type=['"]hidden['"]\s+name=['"]auth_key['"]\s+value=['"]([^"']+)/i);
		var referer = body.match(/<input\s+type=['"]hidden['"]\s+name=['"]referer['"]\s+value=['"]([^"']+)/i);
		if (!key || !referer) {
			throw new Error('Cannot find auth key in index page.');
		}
		// post login
		logger.info('--> POST %s', this._url + '/index.php?app=core&module=global&section=login&do=process');
		return request({
			method: 'POST',
			uri: this._url + '/index.php?app=core&module=global&section=login&do=process',
			jar: this._cookieJar,
			simple: false,
			form: {
				auth_key: key[1],
				anonymous: '1',
				referer: referer[1],
				ips_username: this._username,
				ips_password: this._password
			},
			resolveWithFullResponse: true

		}).then(response => {

			if (response.body.match(/username or password incorrect/i)) {
				throw new Error('Wrong credentials when loggin in.');
			}
			if (response.statusCode !== 302) {
				throw new Error('Unexpected response when logging in (%s).', response.statusCode);
			}
			logger.info('Login successful.');
		});
	});
};

module.exports = IPS;