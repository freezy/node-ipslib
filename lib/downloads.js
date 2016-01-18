"use strict";

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const ent = require('ent');
const logger = require('winston');
const chrono = require('chrono-node');
const resolve = require('path').resolve;
const basename = require('path').basename;

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
				let id;
				if (/showcat=\d+/i.test(url)) {
					id = parseInt(url.match(/showcat=(\d+)/i)[1]);
				} else {
					id = parseInt(basename(url).match(/^\d+/)[0]);
				}

				return {
					label: a.html(),
					url: url,
					id: id
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
 * @param {Number} cat Category ID
 * @param {{ [forceRefresh]: Boolean, [letter]: String }} [opts] Options
 * @returns {Promise.<[{url: String, id: Number, title: String, description: String, views: Number, author: String}]>} All items of a given category
 */
Downloads.prototype.getFiles = function(cat, opts) {

	var files;
	return Promise.try(() => {
		if (fs.existsSync(this._fileCache)) {
			files = JSON.parse(fs.readFileSync(this._fileCache));
			if (!files[cat]) {
				files[cat] = [];
			}
		}
		if (!opts.forceRefresh && !_.isEmpty(files[cat])) {
			return files[cat];
		}

		return this._fetchPage(cat, 1, opts).then(result => {
			if (!_.isEmpty(files[cat])) {

				// merge results
				result.forEach(file => {
					files[cat] = _.filter(files[cat], f => f.id !== file.id);
				});
				files[cat] = files[cat].concat(result);
			} else {
				files[cat] = result;
			}
			fs.writeFileSync(this._fileCache, JSON.stringify(files, null, '\t'));

			return files[cat];
		});
	});
};

/**
 * Recursively fetches all items for a given category.
 *
 * @param {Number} cat Category ID
 * @param {Number} [page] Page to start
 * @param {{ pageSize: Number, letter: String, sortKey: String, sortOrder: String, firstPageOnly: Boolean }} [opts] Options
 * @param [items] Internal callback parameter
 * @returns {Promise.<[{url: String, id: Number, title: String, description: String, views: Number, author: String}]>} All items of a given category
 * @private
 */
Downloads.prototype._fetchPage = function(cat, page, opts, items) {
	opts = opts || {};
	opts.pageSize = opts.pageSize || 25;
	items = items || [];
	page = page || 1;

	const started = new Date().getTime();
	return Promise.try(() => {
		let url;
		let sortKey = 'sort_key=' + (opts.sortKey ? opts.sortKey : 'file_name');
		let sortOrder = 'sort_order=' + (opts.sortOrder ? opts.sortOrder : 'ASC');
		if (opts.letter) {
			url = '/index.php?app=downloads' +
				'&module=display&section=categoryletters' +
				'&cat=' + cat +
				'&letter=' + opts.letter +
				'&' + sortOrder + '&' + sortKey +
				'&num=' + opts.pageSize +
				'&st=' + ((page - 1) * opts.pageSize);
			logger.info('Fetching page %d for category %s and letter "%s".', page, cat, opts.letter);
		} else {
			url = '/index.php?app=downloads' +
				'&showcat=' + cat +
				'&' + sortOrder + '&' + sortKey +
				'&num=' + opts.pageSize +
				'&st=' + ((page - 1) * opts.pageSize);
			logger.log('info', '[vpf] Fetching page %d for category %s.', page, cat);
		}
		return this._ibs._get(url);

	}).then($ => {

		let pages = $('.pagination li.pagejump a').text();
		let numPages = /\d+ of \d+/i.test(pages) ? parseInt(pages.match(/\d+ of (\d+)/i)[1]) : 1;

		logger.log('info', 'Number of pages: %d', numPages);

		items = items.concat($('.idm_category_row').filter(function () {
			return $(this).find('.ipsType_subtitle a').attr('href').match(/showfile=\d+/i);

		}).map(function () {
			let row = $(this);
			let url = row.find('.ipsType_subtitle a').attr('href').replace(/s=[0-9a-f]+&?/i, '');
			let fileinfo = row.find('.file_info').html().match(/([\d,]+)\s+downloads\s+\(([\d,]+)\s+views/i);
			let author = row.find('.basic_info .desc').html().match(/by\s+([^\s]+)/i);
			let descr = row.find('span[class="desc"]').html();
			return {
				url: url,
				id: parseInt(url.match(/showfile=(\d+)/i)[1]),
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
			return this._fetchPage(cat, page + 1, opts, items);
		}
	});
};

module.exports = Downloads;