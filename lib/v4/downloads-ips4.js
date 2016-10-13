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
const toMarkdown = require('to-markdown');

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
								id: this._parseIdFromUrl(url),
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

	/**
	 * Recursively fetches all items for a given category.
	 *
	 * @param {number|{id: number, label: string, url: string}} cat Category
	 * @param {number} [page] Page to start
	 * @param {{ delay: number, sortKey: string, sortOrder: string, firstPageOnly: boolean }} [opts] Options
	 * @param [items] Internal callback parameter
	 * @returns {Promise.<[{url: string, id: number, title: string, description: string, views: number, author: string, [broken]: boolean}]>} All items of a given category
	 * @private
	 */
	_fetchPage(cat, page, opts, items) {
		opts = opts || {};
		items = items || [];
		page = page || 1;

		const url = parseUrl(cat.url, true);
		delete url.search;

		const started = new Date().getTime();
		const logger = this._ips.logger;
		return Promise.try(() => {

			url.query = url.query || {};
			url.query.sortby = opts.sortKey || 'file_name';
			url.query.sortdirection = opts.sortOrder || 'asc';
			url.query.page = page;
			logger.info('Fetching page %d for %s.', page, cat.label);

			return this._ips._get(formatUrl(url));

		}).then($ => {
			const pages = $('.ipsPagination li.ipsPagination_pageJump a').text();
			const numPages = /\d+ of \d+/i.test(pages) ? parseInt(pages.match(/\d+ of (\d+)/i)[1], 10) : 1;

			items = items.concat($('.ipsDataList > .ipsDataItem').map((index, el) => {
				let row = $(el);
				let url         = row.find('.ipsDataItem_title .ipsContained a').attr('href').replace(/s=[0-9a-f]+&?/i, '');
				let title       = row.find('.ipsDataItem_title a').attr('title').replace(/^View the file\s+/ig, '');
				let fileInfo    = row.find('.ipsDataItem_main > p.ipsType_normal i.fa-arrow-circle-down').parent().text().match(/([\d,]+)\s+downloads/i);
				let author      = row.find('.ipsDataItem_main p.ipsType_reset a').text();
				let description = row.find('.ipsDataItem_main .ipsType_richText').html();
				let res = {
					url: url,
					id: this._parseIdFromUrl(url),
					title: title,
					description: description ? toMarkdown(description, { gfm: true }).trim() : '',
					downloads: fileInfo ? parseInt(fileInfo[1].replace(/,/, ''), 10) : null,
					author: author
				};
				// if (/broken/i.test(row.find('span.ipsBadge.ipsBadge_red').html())) {
				// 	res.broken = true;
				// }
				return res;
			}).get());

			if (opts.firstPageOnly || page >= numPages) {
				logger.info('Fetched %d items in %s seconds.', items.length, Math.round((new Date().getTime() - started) / 100) / 10);
				return items;
			} else {
				let delay = Math.floor(Math.random() * ( opts.maxDelay - opts.minDelay + 1)) + opts.minDelay;
				return Promise.delay(delay).then(() => this._fetchPage(cat, page + 1, opts, items));
			}
		});
	}

	/**
	 * Fetches the download URL of a given file.
	 * Also retrieves file details and saves it to the cache.
	 *
	 * @param {{url: string, [description]: string}} cachedFile File from cache
	 * @returns {Promise.<string>}
	 * @private
	 */
	_getDownloadUrl(cachedFile) {

		return Promise.try(() => {
			// fetch the "overview" page
			return this._ips._getAuthenticated(cachedFile.url);

		}).then($ => {

			// check if need to login
			if ($('#elSignInLink').html()) {
				return this._ips._login().then(() => this._ips._getAuthenticated(cachedFile.url));
			}
			return $;

		}).then($ => {

			// parse important shit
			let description = toMarkdown($('.ipsPad .ipsType_richText'), { gfm: true }).trim();
			throw new Error('Allokay.');

			let info = $('h3.bar').filter(function() {
				return /file information/i.test($(this).html());

			}).next().find('> li').map(function() {
				let row = $(this);
				let value = ent.decode(row.html())
					.replace(/<strong[^>]+>.*?<\/strong>/, '').trim()
					.replace(/^<a.*?([-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b\/?[-a-z0-9@:%_\+.~#?&//=]*).*/i, '$1');
				return {
					name: row.find('strong.title').html().trim().replace(/:$/, ''),
					value: value
				};

			}).get();
			let fileListUrl = $('a.download_button').attr('href');

			// update potentially more complete description
			cachedFile.description = description ? ent.decode(description.trim()) : cachedFile.description;
			cachedFile.info = info;

			// need to login first?
			if ($('a#sign_in').html()) {
				return this._ips._login().then(() => fileListUrl);
			}
			return fileListUrl;
		});
	}

	/**
	 * Parses the ID from an URL, supporting both type of URLs
	 * @param {string} url
	 * @param {string} param Name of the parameter
	 * @returns {Number} ID
	 */
	_parseIdFromUrl(url) {
		var match = basename(url).match(/^\d+/);
		if (!match) {
			throw new Error('Cannot parse ID from "' + url + '".');
		}
		return parseInt(match[0], 10);
	}

};