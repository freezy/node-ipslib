"use strict";

const rp = require('request-promise');

module.exports = class {

	constructor(ips, username, password, url, cookieJar) {
		this._ips = ips;
		this._username = username;
		this._password = password;
		this._url = url;
		this._cookieJar = cookieJar;
		this.logger = ips.logger;
	}

	/**
	 * Logs the user in.
	 *
	 * Run this before accessing protected URLs and make sure you use
	 * {@link _getAuthenticated()} after that.
	 *
	 * @returns {Promise}
	 */
	login() {
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
	}

	/**
	 * Closes a session.
	 *
	 * Note that this must be called explictly, otherwise the session stays open
	 * even across restarts.
	 * @returns {Promise}
	 */
	logout() {
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
	}
};