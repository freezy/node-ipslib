"use strict";

const Promise = require('bluebird');
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
	 * @returns {Promise.<{id?: number, label: string, url: string}[]>} Downloaded or cached categories
	 */
	getCategories(opts) {

		opts = opts || {};

		return Promise.try(() => {

			if (!opts.forceRefresh && fs.existsSync(this._categoryCachePath)) {
				return Promise.resolve(super._getCategoryCache());
			}
			return this._ips._get('/files/categories/').then($ => {
				var mainCategories = $('.ipsBox').find('.ipsDataItem_title > a').map((index, el) => {
					return $(el).attr('href').replace(/s=[0-9a-f]+&?/i, '');
				}).get();

				return Promise.mapSeries(mainCategories, mainCategoryUrl => {
					return this._ips._get(mainCategoryUrl).then($ => {
						return $('.ipsSideMenu_list > li > a').map((index, a) => {
							let url = $(a).attr('href').replace(/s=[0-9a-f]+&?/i, '');
							return {
								label: _.unescape($(a).find('.ipsBadge').remove().end().text()),
								url: url
							};
						}).get();
					});
				});
			}).then(result => {
				let categories = _.flatten(result);
				fs.writeFileSync(this._categoryCachePath, JSON.stringify(categories, null, '\t'));
				return categories;
			});
		});
	}
};