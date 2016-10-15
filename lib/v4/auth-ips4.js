"use strict";

const fs = require('fs');
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

				if (response.body.match(/password you entered is incorrect/i)) {
					throw new Error('Wrong credentials when logging in.');
				}
				if (response.statusCode !== 301) {
					fs.writeFileSync('result-login.html', response.body);
					throw new Error(`Unexpected response when logging in (${response.statusCode}).`);
				}
				this.logger.info('Login successful.');
				return true;
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
			return this._ips._getAuthenticated('/');

		}).then($ => {

			if ($('#cUserLink a.ipsUserPhoto > img').length === 0) {
				this.logger.warn('Looks like you are not logged in anyway, aborting.');
				return false;
			}

			// get logout link
			const url = $('[data-menuitem="signout"] > a').attr('href');

			if (!url) {
				throw new Error('Could not find logout link.');
			}

			// logout
			this.logger.info('--> GET %s', url);
			return rp({
				method: 'GET',
				uri: url,
				jar: this._cookieJar,
				simple: false,
				resolveWithFullResponse: true

			}).then(response => {
				if (response.statusCode !== 301) {
					fs.writeFileSync('result-logout.html', response.body);
					throw new Error(`Unexpected response when logging out (${response.statusCode}).`);
				}
				this.logger.info('Logout successful.');
				return true;
			});
		});
	}
};