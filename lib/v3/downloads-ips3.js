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
						id: this._parseIdFromUrl(url, 'showcat')
					};
				}).get();

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
	 * @param {{ pageSize: number, delay: number, sortKey: string, sortOrder: string, firstPageOnly: boolean }} [opts] Options
	 * @param [items] Internal callback parameter
	 * @returns {Promise.<[{url: string, id: number, title: string, description: string, views: number, author: string, [broken]: boolean}]>} All items of a given category
	 * @private
	 */
	_fetchPage(cat, page, opts, items) {
		opts = opts || {};
		opts.pageSize = opts.pageSize || 25;
		items = items || [];
		page = page || 1;

		var url = parseUrl(_.isObject(cat) ? cat.url : this._ips._url + '/index.php?app=downloads&showcat=' + cat, true);
		var catId = _.isObject(cat) ? cat.id : cat;
		delete url.search;

		const started = new Date().getTime();
		const logger = this._ips.logger;
		return Promise.try(() => {

			url.query = url.query || {};
			url.query.sort_key = opts.sortKey || 'file_name';
			url.query.sort_order = opts.sortOrder || 'ASC';
			url.query.num = opts.pageSize;
			url.query.st = ((page - 1) * opts.pageSize);
			logger.info('[vpf] Fetching page %d for category %s.', page, catId);

			return this._ips._get(formatUrl(url));

		}).then($ => {

			let pages = $('.pagination li.pagejump a').text();
			let numPages = /\d+ of \d+/i.test(pages) ? parseInt(pages.match(/\d+ of (\d+)/i)[1], 10) : 1;

			items = items.concat($('.idm_category_row').filter(function() {
				let title = $(this).find('.ipsType_subtitle a').attr('title');
				return title && title.match(/view file/i);

			}).map(function() {
				let row = $(this);
				let url = row.find('.ipsType_subtitle a').attr('href').replace(/s=[0-9a-f]+&?/i, '');
				let fileinfo = row.find('.file_info').html().match(/([\d,]+)\s+downloads\s+\(([\d,]+)\s+views/i);
				let author = row.find('.basic_info .desc').html().match(/by\s+([^\s]+)/i);
				let descr = row.find('span[class="desc"]').html();
				let res = {
					url: url,
					id: this.parseIdFromUrl(url, 'showfile'),
					title: row.find('h3.ipsType_subtitle a').attr('title').replace(/^view file named\s+/ig, ''),
					description: descr ? ent.decode(descr).trim() : '',
					downloads: fileinfo ? parseInt(fileinfo[1].replace(/,/, ''), 10) : null,
					views: fileinfo ? parseInt(fileinfo[2].replace(/,/, ''), 10) : null,
					author: author ? author[1] : row.find('.___hover___member span').html()
				};
				if (/broken/i.test(row.find('span.ipsBadge.ipsBadge_red').html())) {
					res.broken = true;
				}
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

			// parse important shit
			let description = $('div.ipsType_textblock.description_content').html();
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
	_parseIdFromUrl(url, param) {
		var regex = new RegExp(param + '=(\\d+)', 'i');
		if (regex.test(url)) {
			return parseInt(regex.exec(url)[1], 10);
		}
		return parseInt(basename(url).match(/^\d+/)[0], 10);
	}
};