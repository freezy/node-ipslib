"use strict";

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const rp = require('request-promise');
const winston = require('winston');
const resolve = require('path').resolve;
const cheerio = require('cheerio');
const CookieStore = require('tough-cookie-filestore');

const Downloads = require('./lib/downloads');

/**
 * Initializes the library.
 *
 * @param {string} name Name of the board
 * @param {string} url URL of the board, without /index.php
 * @param {string} [username] Username
 * @param {string} [password] Password
 * @param {{}} [opts] Options
 * @constructor
 */
function IPS(name, url, username, password, opts) {

	this.id = _.kebabCase(name);
	this._name = name;
	this._url = url.replace(/\/$/, '');
	this._username = username;
	this._password = password;

	this._cache = resolve(process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'], '.ipslib');
	if (!fs.existsSync(this._cache)) {
		fs.mkdirSync(this._cache)
	}
	this._cookieJar = rp.jar(new CookieStore(resolve(this._cache, this.id + '-cookies.json')));

	// sub-modules
	this.downloads = new Downloads(this, opts);

	// utils
	this.logger = winston;
}

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
	this.logger.info('--> GET %s', config.uri);
	return rp(config);
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
	this.logger.info('--> GET %s (authenticated)', config.uri);
	return rp(config);
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
		this.logger.info('--> GET %s', this._url + '/index.php');
		return rp({ uri: this._url + '/index.php', jar: this._cookieJar });

	}).then(body => {
		var match = body.match(/<a\shref="([^"]+do=logout[^"]+)/);
		if (match) {
			let uri = decodeURI(match[1]).replace(/&amp;/gi, '&');
			this.logger.info('--> GET %s', uri);
			return rp({ uri: uri, jar: this._cookieJar }).then(body => {
				if (new RegExp('>' + this._username + ' &nbsp;', 'i').test(body)) {
					throw new Error('Logout failed.');
				}
				this.logger.info('Logout successful.');
			});

		} else {
			this.logger.warn('Looks like you are not logged in anyway, aborting.');
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
		this.logger.info('--> GET %s', this._url + '/');
		return rp({ uri: this._url + '/', jar: this._cookieJar });

	}).then(body => {

		if (new RegExp('>' + this._username + ' &nbsp;', 'i').test(body)) {
			this.logger.info("User already logged, skipping login.");
			return;
		}

		// get whatever the fuck this auth key is...
		var key = body.match(/<input\s+type=['"]hidden['"]\s+name=['"]auth_key['"]\s+value=['"]([^"']+)/i);
		var referer = body.match(/<input\s+type=['"]hidden['"]\s+name=['"]referer['"]\s+value=['"]([^"']+)/i);
		if (!key || !referer) {
			throw new Error('Cannot find auth key in index page.');
		}
		// post login
		this.logger.info('--> POST %s', this._url + '/index.php?app=core&module=global&section=login&do=process');
		return rp({
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
				throw new Error('Wrong credentials when logging in.');
			}
			if (response.statusCode !== 302) {
				throw new Error('Unexpected response when logging in (%s).', response.statusCode);
			}
			this.logger.info('Login successful.');
		});
	});
};

module.exports = IPS;