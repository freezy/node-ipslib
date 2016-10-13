"use strict";

const rp = require('request-promise');

module.exports = class {

	constructor(ips, username, password, url, cookieJar) {
		this._ips = ips;
		this._username = username;
		this._password = password;
		this._url = url;
		this._cookieJar = cookieJar;
	}

	/**
	 * Logs the user in.
	 *
	 * Run this before accessing protected URLs and make sure you use
	 * {@link _getAuthenticated()} after that.
	 *
	 * @returns {Promise.<boolean>} True if login was needed, false otherwise.
	 */
	login() {
		return Promise.try(() => {
			if (!this._username || !this._password) {
				throw new Error('Need valid credentials for this action. Instantiate Ips with username and password.');
			}
			return this._ips._getAuthenticated('/');

		}).then($ => {

			if ($('#cUserLink a.ipsUserPhoto > img').attr('alt') === this._username) {
				this.logger.info("User already logged, skipping login.");
				return false;
			}

			// get csrf key
			const csrfKey = $('form.ipsPad input[name="csrfKey"]').attr('value');

			// post login
			this.logger.info('--> POST %s', this._url + '/login/');
			return rp({
				method: 'POST',
				uri: this._url + '/login/',
				jar: this._cookieJar,
				simple: false,
				form: {
					login__standard_submitted: 1,
					csrfKey: csrfKey,
					auth: this._username,
					password: this._password,
					remember_me: 0,
					remember_me_checkbox: 1,
					signin_anonymous: 0,
					signin_anonymous_checkbox: 1
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
		throw new Error('Implement me!');
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