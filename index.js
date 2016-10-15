"use strict";

Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const rp = require('request-promise');
const request = require('request');
const winston = require('winston');
const resolve = require('path').resolve;
const cheerio = require('cheerio');

const CookieJar = require("tough-cookie").CookieJar;
const FileCookieStore = require("tough-cookie-filestore");

const tough = require('tough-cookie');

module.exports = class {

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
	constructor(name, url, username, password, opts) {

		this.id = _.kebabCase(name);
		this._name = name;
		this._url = url.replace(/\/$/, '');
		this._username = username;
		this._password = password;

		// create cache folder
		this._cache = resolve(process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'], '.ipslib');

		// create cookie jar
		if (!fs.existsSync(this._cache)) {
			fs.mkdirSync(this._cache)
		}
		this._cookieJar = request.jar();
		//this._cookieJar = request.jar(new FileCookieStore(resolve(this._cache, this.id + '-cookies.json')));
		//this._cookieJar = new CookieJar(new FileCookieStore(resolve(this._cache, this.id + '-cookies.json')));
		//this._cookieJar = new tough.CookieJar(null, {});
		this._cookieJar._jar.rejectPublicSuffixes = false;

		this._opts = opts || {};
		this._opts.version = this._opts.version || 4;

		// utils
		this.logger = winston;

		// sub-module classes
		const DownloadModule = require('./lib/v' + this._opts.version + '/downloads-ips' + this._opts.version);
		const AuthModule = require('./lib/v' + this._opts.version + '/auth-ips' + this._opts.version);

		// sub-modules
		this.downloads = new DownloadModule(this, this._opts);
		this.auth = new AuthModule(this, username, password, this._url, this._cookieJar);


	}

	/**
	 * Performs a GET request to the provided URL path, as anonymous.
	 * @param url Complete URL or path
	 * @returns Promise<Cheerio> Parsed HTML body
	 * @private
	 */
	_get(url) {
		const config = {
			uri: url[0] === '/' ? this._url + url : url,
			transform: function(body) {
				return cheerio.load(body);
			},
			jar: false
		};
		this.logger.info('--> GET %s', config.uri);
		return rp(config);
	}

	/**
	 * Performs a GET request to the provided URL path, with the current session, if logged.
	 * @param url Complete URL or path
	 * @returns Promise<Cheerio> Parsed HTML body
	 * @private
	 */
	_getAuthenticated(url) {
		const config = {
			uri: url[0] === '/' ? this._url + url : url,
			transform: function(body) {
				return cheerio.load(body);
			},
			jar: this._cookieJar
		};
		this.logger.info('--> GET %s (authenticated)', config.uri);
		return rp(config);
	}

	/**
	 * Closes a session.
	 *
	 * Note that this must be called explictly, otherwise the session stays open
	 * even across restarts.
	 * @returns {Promise}
	 */
	logout() {
		return this.auth.logout();
	}

	/**
	 * Logs the user in.
	 *
	 * Run this before accessing protected URLs and make sure you use
	 * {@link _getAuthenticated()} after that.
	 *
	 * @returns {Promise}
	 * @private
	 */
	_login() {
		return this.auth.login();
	}
};