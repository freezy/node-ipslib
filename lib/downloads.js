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

function Downloads(ips, opts) {
	this._ips = ips;
	this._categoryCachePath = resolve(ips._cache, ips.id + '-categories.json');
	this._fileCachePath = resolve(ips._cache, ips.id + '-files.json');
	this._opts = opts;
}

/**
 * Returns the first category that matches the provided query.
 * Fuzzy search is applied, i.e. "fun pics" will match "Funny Pics".
 *
 * @param {string} query Search query
 * @param [opts] Options to pass to {@link #getCategories()}
 * @returns {Promise.<{id: number, label: string, url: string}>} Matched category or null if nothing found.
 */
Downloads.prototype.findCategory = function(query, opts) {
	let regex = new RegExp(query.replace(/[^a-z0-9\s]+/gi, '').replace(/\s+/, '.*?'), 'i');
	return this.getCategories(opts).then(categories => _.find(categories, c => regex.test(c.label)));
};

/**
 * Returns the first file that matches the provided query for a given category.
 * Fuzzy search is applied.
 *
 * @param {string} query Search query
 * @param {Number|{id: number, label: string, url: string}} cat Category
 * @param [opts] Options to pass to {@link #getFiles()}
 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }>}
 */
Downloads.prototype.findFile = function(query, cat, opts) {
	return this.getFiles(cat, opts).then(files => _.find(files, matchFile(query)));
};

/**
 * Returns the all files that match the provided query for a given category.
 * Fuzzy search is applied.
 *
 * @param {String} query Search query
 * @param {number|{id: Number, label: string, url: string}} cat Category
 * @param [opts] Options to pass to {@link #getFiles()}
 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }[]>}
 */
Downloads.prototype.findFiles = function(query, cat, opts) {
	return this.getFiles(cat, opts).then(files => _.filter(files, matchFile(query)));
};

/**
 * Returns all download categories.
 *
 * @param {{ [forceRefresh]: boolean }} [opts] Options
 * @returns {Promise.<{id: number, label: string, url: string}[]>} Downloaded or cached categories
 */
Downloads.prototype.getCategories = function(opts) {

	opts = opts || {};

	return Promise.try(() => {

		if (!opts.forceRefresh && fs.existsSync(this._categoryCachePath)) {
			return Promise.resolve(this._getCategoryCache());
		}
		return this._ips._get('/index.php?app=downloads').then($ => {
			var categories = $('#idm_categories').find('li > a').filter(function() {
				let a = $(this);
				return a.attr('title') && !a.hasClass('cat_toggle');

			}).map(function() {
				let a = $(this);
				let url = a.attr('href').replace(/s=[0-9a-f]+&?/i, '');
				return {
					label: _.unescape(a.html()),
					url: url,
					id: parseIdFromUrl(url, 'showcat')
				};
			}).get();

			fs.writeFileSync(this._categoryCachePath, JSON.stringify(categories, null, '\t'));
			return categories;
		});
	});
};

/**
 * Returns all files of a given category.
 *
 * @param {Number|{id: number, label: string, url: string}} cat Category
 * @param {{ [forceRefresh]: boolean, [minDelay]: number, [maxDelay]: number }} [opts] Options
 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }[]>} All items of a given category
 */
Downloads.prototype.getFiles = function(cat, opts) {

	if (!cat) {
		return Promise.resolve([]);
	}

	opts = opts || {};
	opts.minDelay = opts.minDelay || 500;
	opts.maxDelay = opts.maxDelay || 2000;

	var files;
	return Promise.try(() => {

		if (_.isObject(cat) && !cat.url) {
			throw new Error('Category must contain an `url` property.')
		} else if (!_.isObject(cat) && !_.isNumber(cat)) {
			throw new Error('Category must be a number when not providing an object.');
		}
		let catId = _.isObject(cat) ? cat.id : cat;

		files = this._getFileCache(catId);
		if (!opts.forceRefresh && !_.isEmpty(files)) {
			return files;
		}

		return this._fetchPage(cat, 1, opts).then(result => {
			if (!_.isEmpty(files)) {

				// merge results:
				result.forEach(file => {
					// 1. remove existing files from cache
					files = _.filter(files, f => f.id !== file.id);
				});
				// 2. append new files to cache
				files = files.concat(result);
			} else {
				files = result;
			}
			this._saveFileCache(catId, files);
			return this._getFileCache(catId);
		});
	});
};

/**
 * Retrieves file details, inclusively file name.
 *
 * @param file
 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }>}
 */
Downloads.prototype.getFileDetails = function(file) {

	const logger = this._ips.logger;
	let cachedFile = _.find(this._getFileCache(file.category), { id: file.id });
	if (!cachedFile) {
		return Promise.reject(new Error('Must provide a file retrieved from #getFiles(), #findFiles() or #findFile().'));
	}

	return this._getDownloadUrl(cachedFile).then(downloadUrl => {

		this._saveFileCache();
		return this._prepareDownload({ url: downloadUrl, jar: this._ips._cookieJar });

	}).spread((readStream, body, filename) => {

		if (body) {
			let $ = cheerio.load(body);
			cachedFile.files = $('#files > ul > li').map(function() {
				return $(this).find('strong.name').html();
			}).get();

		} else {

			throw new Error('Got a stream, aborting.');
			//logger.warn('Got a stream, this counts as download!');
			//cachedFile.files = [ filename ];
		}
		this._saveFileCache();
		return cachedFile;
	});
};

/**
 * Downloads one or more files to the given destination.
 *
 * If an array of files is given, all files will be downloaded.
 *
 * @param {{url: string, id: number, category: string}|{url: string, id: number, category: string}[]} file
 * @param {string} destFolder Destination folder
 * @param {{allFiles: boolean, filename: string}} [opts] Options.
 * @returns {Promise.<{string}>|Promise.<{String[]}>} Path(s) to downloaded file(s)
 */
Downloads.prototype.download = function(file, destFolder, opts) {
	return Promise.try(() => {
		if (_.isArray(file)) {
			return Promise.each(file, f => this._downloadFile(f, destFolder, opts));
		}
		return this._downloadFile(file, destFolder, opts);
	}).then(result => {
		this._saveFileCache();
		return result;
	});
};

/**
 * Fetches the download URL of a given file.
 * Also retrieves file details and saves it to the cache.
 *
 * @param {{url: string, [description]: string}} cachedFile File from cache
 * @returns {Promise.<string>}
 * @private
 */
Downloads.prototype._getDownloadUrl = function(cachedFile) {

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
};

/**
 * Downloads a file to the given destination.
 *
 * @param {{url: string, id: number, category: string}} file
 * @param {string} destFolder Destination folder
 * @param {{allFiles: boolean}} [opts] Options.
 * @returns {Promise.<{string}>} Path to downloaded file
 * @private
 */
Downloads.prototype._downloadFile = function(file, destFolder, opts) {

	opts = opts || {};
	const logger = this._ips.logger;
	let cachedFile = _.find(this._getFileCache(file.category), { id: file.id });
	if (!cachedFile) {
		return Promise.reject(new Error('Must provide a file retrieved from #getFiles(), #findFiles() or #findFile().'));
	}

	return this._getDownloadUrl(cachedFile).then(downloadUrl => {

		if (this._opts.waitPeriod) {
			logger.info('Waiting %dms...', this._opts.waitPeriod);
			return Promise.delay(this._opts.waitPeriod).then(() => downloadUrl);
		}
		return downloadUrl;

	}).then(downloadUrl => {

		// fetch "file list" page
		return this._prepareDownload({ url: downloadUrl, jar: this._ips._cookieJar });

	}).spread((readStream, body, filename) => {

		// no body means a stream, so download file.
		if (!body) {
			cachedFile.filename = filename;
			return this._streamFile(readStream, filename, destFolder)
		}

		// check status code
		let response = readStream;
		if (response.statusCode !== 200) {
			throw new Error('Status code is ' + response.statusCode + ' instead of 200 when downloading confirmation page.');
		}

		// can be multiple, they are sorted by date ascending, so latest is last item.
		let $ = cheerio.load(body);
		let binaryUrl;
		if (opts.allFiles) {
			throw new Error('Multi-downloads not yet implemented.');
		} else {
			binaryUrl = $('a.download_button').first().attr('href');
		}

		return this._prepareDownload({ url: binaryUrl, jar: this._ips._cookieJar }).spread((readStream, body, filename) => {

			// no body means a stream, so download file.
			if (!body) {
				cachedFile.filename = filename;
				return this._streamFile(readStream, filename, destFolder)
			}

			if (body.match(/You have exceeded the maximum number of downloads allotted to you for the day/i)) {
				throw new Error('Number of daily downloads exceeded.');
			}
			if (body.match(/You may not download any more files until your other downloads are complete/i)) {
				throw new Error('Too many simulataneous downloads.');
			}
			fs.writeFileSync('download-debug.html', body);
			throw new Error('Unknown error, see download-debug.html.');
		});
	});
};

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
Downloads.prototype._fetchPage = function(cat, page, opts, items) {
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
		logger.info('info', '[vpf] Fetching page %d for category %s.', page, catId);

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
				id: parseIdFromUrl(url, 'showfile'),
				title: row.find('h3.ipsType_subtitle a').attr('title').replace(/^view file named\s+/ig, ''),
				description: descr ? ent.decode(descr).trim() : '',
				downloads: parseInt(fileinfo[1].replace(/,/, ''), 10),
				views: parseInt(fileinfo[2].replace(/,/, ''), 10),
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
			let delay = Math.floor(Math.random() * ( opts.maxDelay -  opts.minDelay + 1)) +  opts.minDelay;
			return Promise.delay(delay).then(() => this._fetchPage(cat, page + 1, opts, items));
		}
	});
};

/**
 * Tries to download a binary file. However, download URLs at IPS might
 * randomly return a confirmation page instead of the binary stream. So this
 * checks what it is and resolves with three parameters:
 *
 *   1. Binary stream.
 *   2. HTML body. If null, a binary stream was received.
 *   3. File name if known, null otherwise.
 *
 * @param {object} options Options passed to "request()"
 * @returns {Promise.<*[]>}
 * @private
 */
Downloads.prototype._prepareDownload = function(options) {

	const logger = this._ips.logger;
	return new Promise((resolve, reject) => {

		logger.info('--> GET %s', options.url);
		let req = request(options);
		req.on('response', response => {

			// return stream
			if (response.statusCode === 200 && response.headers['content-disposition']) {
				req.pause(); // https://github.com/request/request/issues/1402
				let match = response.headers['content-disposition'].match(/filename="([^"]+)"/i);
				let filename;
				if (match) {
					filename = match[1];
				} else {
					filename = response.headers['content-disposition'].substr(response.headers['content-disposition'].toLowerCase().indexOf('filename'));
					filename = filename.trim().replace(/\s/g, '.').replace(/[^\w\d\.\-]/gi, '');
					logger.warn('Messed up Content-Disposition "%s", taking whole string "%s".', response.headers['content-disposition'], filename);
				}
				resolve([response, null, filename]);

			// stream to memory
			} else {
				let chunks = [];
				response.on('data', function(chunk) {
					chunks.push(chunk);

				}).on('end', function() {
					let buffer = Buffer.concat(chunks);
					resolve([response, buffer.toString(), null]);

				}).on('error', reject);
			}
		});
	});
};

/**
 * Streams a request object's data to a file.
 *
 * Note that we assume that the stream is paused due to a general
 * streams issue.
 *
 * @param {Stream} readStream Request stream
 * @param {string} filename File name as in HTTP header
 * @param {string} destFolder Local destination folder
 * @returns {Promise.<string>}
 * @private
 */
Downloads.prototype._streamFile = function(readStream, filename, destFolder) {

	const logger = this._ips.logger;
	const started = new Date().getTime();
	const dest = resolve(destFolder, filename);
	return new Promise((resolve, reject) => {

		logger.info('Streaming to %s...', dest);
		var writeStream = fs.createWriteStream(dest);
		writeStream.on('close', () => {

			var fd = fs.openSync(dest, 'r');
			var size = fs.fstatSync(fd).size;
			fs.closeSync(fd);

			logger.info('Downloaded %d bytes to %s in %d seconds.', size, dest, (new Date().getTime() - started) / 1000);
			resolve(dest);

		}).on('error', reject);
		readStream.on('error', reject);
		readStream.resume();
		readStream.pipe(writeStream);
	});
};

/**
 * Returns all cached categories or an empty array if nothing cached.
 *
 * @returns {{label: string, url: string, id: number}[]} Cached categories
 * @private
 */
Downloads.prototype._getCategoryCache = function() {

	if (this._categoryCache) {
		return this._categoryCache;
	}
	if (!fs.existsSync(this._categoryCachePath)) {
		return [];
	}
	return this._categoryCache = JSON.parse(fs.readFileSync(this._categoryCachePath));
};

/**
 * Returns all cached files or an empty array if nothing cached.
 *
 * @param {string} categoryId ID of the category
 * @returns {{url: string, id: number, title: string, description: string, views: number, author: string, category: string}[]} Cached files
 * @private
 */
Downloads.prototype._getFileCache = function(categoryId) {

	if (this._fileCache && this._fileCache[categoryId]) {
		return this._fileCache[categoryId].map(file => Object.assign(file, { category: categoryId }));
	}
	if (!fs.existsSync(this._fileCachePath)) {
		return [];
	}
	this._fileCache = JSON.parse(fs.readFileSync(this._fileCachePath));
	if (!this._fileCache[categoryId]) {
		this._fileCache[categoryId] = [];
	}
	return this._fileCache[categoryId].map(file => Object.assign(file, { category: categoryId }));
};

/**
 * Saves updated files back to cache.
 *
 * If both parameters are set, files of given category are replaced.
 *
 * @param {string} [categoryId]
 * @param {{url: string, id: number, title: string, description: string, views: number, author: string, [category]: number}[]} [files]
 * @private
 */
Downloads.prototype._saveFileCache = function(categoryId, files) {

	if (categoryId && files) {
		this._fileCache[categoryId] = files;
	}
	fs.writeFileSync(this._fileCachePath, JSON.stringify(this._fileCache, null, '\t'));
};


/**
 * Parses the ID from an URL, supporting both type of URLs
 * @param {string} url
 * @param {string} param Name of the parameter
 * @returns {Number} ID
 */
function parseIdFromUrl(url, param) {
	var regex = new RegExp(param + '=(\\d+)', 'i');
	if (regex.test(url)) {
		return parseInt(regex.exec(url)[1], 10);
	}
	return parseInt(basename(url).match(/^\d+/)[0], 10);
}

/**
 * Returns a regex from a search query.
 * @param query Search query
 * @returns {RegExp}
 */
function getSearchRegex(query) {
	return new RegExp(query.replace(/[^a-z0-9\s_-]+/gi, '').replace(/\s+/, '.*?'), 'i');
}

/**
 * Returns a function that matches a file for a given query.
 * @param {string} query
 * @returns {Function} Match function
 */
function matchFile(query) {
	var regex = getSearchRegex(query);
	return function(file) {
		return regex.test(file.title) || regex.test(file.description)
	}
}

module.exports = Downloads;