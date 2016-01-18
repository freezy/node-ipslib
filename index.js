"use strict";

const fs = require('fs');
const resolve = require('path').resolve;
const logger = require('winston');
const cheerio = require('cheerio');
const request = require('request-promise');

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
	this._url = url;
	this._username = username;
	this._password = password;
	this._prefix = name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

	this._cache = resolve(process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'], '.ipslib');
	if (!fs.existsSync(this._cache)) {
		fs.mkdirSync(this._cache)
	}

	// sub-modules
	this.downloads = new Downloads(this);
};

/**
 * Performs a GET request to the provided URL path
 * @param path Absolute path, without domain
 * @returns Promise<T.Cheerio> Parsed HTML body
 * @private
 */
IPS.prototype._get = function(path) {
	const config = {
		uri: this._url + path,
		transform: function(body) {
			return cheerio.load(body);
		}
	};
	logger.info('GET %s', config.uri);
	return request(config);
};

module.exports = IPS;