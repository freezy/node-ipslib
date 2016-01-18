"use strict";

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const ent = require('ent');
const logger = require('winston');
const chrono = require('chrono-node');
const resolve = require('path').resolve;
const basename = require('path').basename;
const parseUrl = require('url').parse;
const formatUrl = require('url').format;

const Downloads = function Downloads(ips) {
	this._ibs = ips;
	this._categoryCache = resolve(ips._cache, ips._prefix + '-categories.json');
	this._fileCache = resolve(ips._cache, ips._prefix + '-files.json');
};

/**
 * Returns all download categories.
 *
 * @param {{ [forceRefresh]: Boolean }} [opts] Options
 * @returns {Promise.<[{id: Number, label: String, url: String}]>} Downloaded or cached categories
 */
Downloads.prototype.getCategories = function(opts) {

	opts = opts || {};

	return Promise.try(() => {

		if (!opts.forceRefresh && fs.existsSync(this._categoryCache)) {
			return JSON.parse(fs.readFileSync(this._categoryCache));
		}
		return this._ibs._get('/index.php?app=downloads').then($ => {
			var categories = $('#idm_categories').find('li > a').filter(function() {
				let a = $(this);
				return a.attr('title') && !a.hasClass('cat_toggle');

			}).map(function() {
				let a = $(this);
				let url = a.attr('href').replace(/s=[0-9a-f]+&?/i, '');
				return {
					label: a.html(),
					url: url,
					id: parseIdFromUrl(url, 'showcat')
				};
			}).get();

			fs.writeFileSync(this._categoryCache, JSON.stringify(categories, null, '\t'));
			return categories;
		});
	});
};

/**
 * Returns all files of a given category.
 *
 * @param {Number|{id: Number, label: String, url: String}} cat Category
 * @param {{ [forceRefresh]: Boolean, [delay]: Number }} [opts] Options
 * @returns {Promise.<[{url: String, id: Number, title: String, description: String, views: Number, author: String}]>} All items of a given category
 */
Downloads.prototype.getFiles = function(cat, opts) {

	var files;
	return Promise.try(() => {

		if (_.isObject(cat) && !cat.url) {
			throw new Error('Category must contain an `url` property.')
		} else if (!_.isObject(cat) && !_.isNumber(cat)) {
			throw new Error('Category must be a number when not providing an object.');
		}
		let catId = _.isObject(cat) ? cat.id : cat;

		if (fs.existsSync(this._fileCache)) {
			files = JSON.parse(fs.readFileSync(this._fileCache));
			if (!files[catId]) {
				files[catId] = [];
			}
		} else {
			files = {};
		}
		if (!opts.forceRefresh && !_.isEmpty(files[catId])) {
			return files[catId];
		}

		return this._fetchPage(cat, 1, opts).then(result => {
			if (!_.isEmpty(files[catId])) {

				// merge results
				result.forEach(file => {
					files[catId] = _.filter(files[catId], f => f.id !== file.id);
				});
				files[catId] = files[catId].concat(result);
			} else {
				files[catId] = result;
			}
			fs.writeFileSync(this._fileCache, JSON.stringify(files, null, '\t'));

			return files[catId];
		});
	});
};

/**
 * Recursively fetches all items for a given category.
 *
 * @param {Number|{id: Number, label: String, url: String}} cat Category
 * @param {Number} [page] Page to start
 * @param {{ pageSize: Number, delay: Number, sortKey: String, sortOrder: String, firstPageOnly: Boolean }} [opts] Options
 * @param [items] Internal callback parameter
 * @returns {Promise.<[{url: String, id: Number, title: String, description: String, views: Number, author: String}]>} All items of a given category
 * @private
 */
Downloads.prototype._fetchPage = function(cat, page, opts, items) {
	opts = opts || {};
	opts.pageSize = opts.pageSize || 25;
	items = items || [];
	page = page || 1;

	var url = parseUrl(_.isObject(cat) ? cat.url : this._ibs._url + '/index.php?app=downloads&showcat=' + cat, true);
	var catId = _.isObject(cat) ? cat.id : cat;

	const started = new Date().getTime();
	return Promise.try(() => {

		url.query = url.query || {};
		url.query.sortKey = 'sort_key=' + (opts.sortKey ? opts.sortKey : 'file_name');
		url.query.sortOrder = 'sort_order=' + (opts.sortOrder ? opts.sortOrder : 'ASC');
		url.query.num = opts.pageSize;
		url.query.st = ((page - 1) * opts.pageSize);
		logger.log('info', '[vpf] Fetching page %d for category %s.', page, catId);
		return this._ibs._get(formatUrl(url));

	}).then($ => {

		let pages = $('.pagination li.pagejump a').text();
		let numPages = /\d+ of \d+/i.test(pages) ? parseInt(pages.match(/\d+ of (\d+)/i)[1]) : 1;

		logger.log('info', 'Number of pages: %d', numPages);

		items = items.concat($('.idm_category_row').filter(function () {
			let title = $(this).find('.ipsType_subtitle a').attr('title');
			return title && title.match(/view file/i);

		}).map(function () {
			let row = $(this);
			let url = row.find('.ipsType_subtitle a').attr('href').replace(/s=[0-9a-f]+&?/i, '');
			let fileinfo = row.find('.file_info').html().match(/([\d,]+)\s+downloads\s+\(([\d,]+)\s+views/i);
			let author = row.find('.basic_info .desc').html().match(/by\s+([^\s]+)/i);
			let descr = row.find('span[class="desc"]').html();
			return {
				url: url,
				id: parseIdFromUrl(url, 'showfile'),
				title: row.find('h3.ipsType_subtitle a').attr('title').replace(/^view file named\s+/ig, ''),
				description: descr ? ent.decode(descr).trim() : '',
				downloads: parseInt(fileinfo[1].replace(/,/, '')),
				views: parseInt(fileinfo[2].replace(/,/, '')),
				author: author ? author[1] : row.find('.___hover___member span').html()
			};
		}).get());

		if (opts.firstPageOnly || page >= numPages) {
			logger.info('Fetched %d items in %s seconds.', items.length, Math.round((new Date().getTime() - started) / 100) / 10);
			return items;
		} else {
			if (opts.delay) {
				return Promise.delay(opts.delay).then(() => this._fetchPage(cat, page + 1, opts, items));
			} else {
				return this._fetchPage(cat, page + 1, opts, items);
			}

		}
	});
};

module.exports = Downloads;


/**
 * Parses the ID from an URL, supporting both type of URLs
 * @param {String} url
 * @param {String} param Name of the parameter
 * @returns {Number} ID
 */
function parseIdFromUrl(url, param) {
	var regex = new RegExp(param + '=(\\d+)', 'i');
	if (regex.test(url)) {
		return parseInt(regex.exec(url)[1]);
	}
	return parseInt(basename(url).match(/^\d+/)[0]);
}