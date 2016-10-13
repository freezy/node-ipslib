"use strict";

const _ = require('lodash');
const fs = require('fs');
const ent = require('ent');
const chrono = require('chrono-node');
const cheerio = require('cheerio');
const request = require('request');
const resolve = require('path').resolve;
const basename = require('path').basename;
const parseUrl = require('url').parse;
const formatUrl = require('url').format;

const Downloads = require('../downloads');

module.exports = class extends Downloads {

	/**
	 * Returns all download categories.
	 *
	 * @param {{ [forceRefresh]: boolean }} [opts] Options
	 * @returns {Promise.<{id: number, label: string, url: string}[]>} Downloaded or cached categories
	 */
	getCategories(opts) {

		opts = opts || {};

		return Promise.try(() => {

			if (!opts.forceRefresh && fs.existsSync(this._categoryCachePath)) {
				return Promise.resolve(super._getCategoryCache());
			}
			return this._ips._get('/index.php?app=downloads').then($ => {
				var categories = $('#idm_categories').find('li > a').filter((index, el) => {
					let a = $(el);
					return a.attr('title') && !a.hasClass('cat_toggle');

				}).map((index, el) => {
					let a = $(el);
					let url = a.attr('href').replace(/s=[0-9a-f]+&?/i, '');
					return {
						label: _.unescape(a.html()),
						url: url,
						id: super._parseIdFromUrl(url, 'showcat')
					};
				}).get();

				fs.writeFileSync(this._categoryCachePath, JSON.stringify(categories, null, '\t'));
				return categories;
			});
		});
	}
};