"use strict";

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const ent = require('ent');
const cheerio = require('cheerio');
const request = require('request');
const resolve = require('path').resolve;

module.exports = class {

	constructor(ips, opts) {
		this._ips = ips;
		this._categoryCachePath = resolve(ips._cache, ips.id + '-categories.json');
		this._fileCachePath = resolve(ips._cache, ips.id + '-files.json');
		this._opts = opts;
		this.logger = ips.logger;
	}

	/**
	 * Returns the first category that matches the provided query.
	 * Fuzzy search is applied, i.e. "fun pics" will match "Funny Pics".
	 *
	 * @param {string} query Search query
	 * @param [opts] Options to pass to {@link #getCategories()}
	 * @returns {Promise.<{id: number, label: string, url: string}>} Matched category or null if nothing found.
	 */
	findCategory(query, opts) {
		let regex = new RegExp(query.replace(/[^a-z0-9\s]+/gi, '').replace(/\s+/, '.*?'), 'i');
		return this.getCategories(opts).then(categories => _.find(categories, c => regex.test(c.label)));
	}

	/**
	 * Returns the first file that matches the provided query for a given category.
	 * Fuzzy search is applied.
	 *
	 * @param {string} query Search query
	 * @param {Number|{id: number, label: string, url: string}} cat Category
	 * @param [opts] Options to pass to {@link #getFiles()}
	 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }>}
	 */
	findFile(query, cat, opts) {
		return this.getFiles(cat, opts).then(files => _.find(files, this.matchFile(query)));
	}

	/**
	 * Returns the all files that match the provided query for a given category.
	 * Fuzzy search is applied.
	 *
	 * @param {String} query Search query
	 * @param {number|{id: Number, label: string, url: string}} cat Category
	 * @param [opts] Options to pass to {@link #getFiles()}
	 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }[]>}
	 */
	findFiles(query, cat, opts) {
		return this.getFiles(cat, opts).then(files => _.filter(files, this.matchFile(query)));
	}

	/**
	 * Returns all files of a given category.
	 *
	 * @param {number|{id: number, label: string, url: string}} cat Category
	 * @param {{ [forceRefresh]: boolean, [minDelay]: number, [maxDelay]: number, author:string }} [opts] Options
	 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }[]>} All items of a given category
	 */
	getFiles(cat, opts) {

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

			return this._fetchPage(cat, 1, opts).then(fetchedItems => {
				if (!_.isEmpty(files)) {

					// merge results:
					fetchedItems.forEach(file => {

						// 1. copy info and file names before removing old file
						let cachedFile = _.find(files, f => f.id === file.id);
						if (cachedFile) {
							file.info = cachedFile.info ? cachedFile.info : file.info;
							file.listing = cachedFile.listing ? cachedFile.listing : file.listing;
							file.description = cachedFile.description ? cachedFile.description : file.description;
						}
						file.category = catId;

						// 2. remove existing files from cache
						files = _.filter(files, f => f.id !== file.id);
					});
					// 3. append new files to cache
					files = files.concat(fetchedItems);
				} else {
					files = fetchedItems;
				}
				this._saveFileCache(catId, files);
				return this._getFileCache(catId);
			});
		});
	}

	/**
	 * Retrieves file details, inclusively file name.
	 *
	 * @param file
	 * @returns {Promise.<{ url: string, id: number, title: string, description: string downloads: number, views: number, author: string, category: number, [filename]: string, [broken]: boolean }>}
	 */
	getFileDetails(file) {

		throw new Error('Refactor before usage.');
		let cachedFile = _.find(this._getFileCache(file.category), { id: file.id });
		if (!cachedFile) {
			return Promise.reject(new Error('Must provide a file retrieved from #getFiles(), #findFiles() or #findFile().'));
		}

		return this._getDownloadUrl(cachedFile).then(downloadUrl => {

			this._saveFileCache();
			return this._prepareDownload({ url: downloadUrl, jar: this._ips._cookieJar });

		}).spread((readStream, body) => {

			if (!body) {
				throw new Error('Got a stream, aborting.');
			}

			if (body) {
				let $ = cheerio.load(body);
				cachedFile.listing = $('#files > ul > li').map(function() {
					return $(this).find('strong.name').html();
				}).get();
			}
			this._saveFileCache();
			return cachedFile;
		});
	}

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
	download(file, destFolder, opts) {

		opts = opts || {};
		opts.minDelay = opts.minDelay || 500;
		opts.maxDelay = opts.maxDelay || 2000;

		return Promise.try(() => {
			if (_.isArray(file)) {
				return Promise.each(file, f => {
					return this._downloadItem(f, destFolder, opts).then(path => f.localFiles = path);
				});
			}
			return this._downloadItem(file, destFolder, opts);

		}).then(result => {
			this._saveFileCache();
			return result;
		});
	}

	/**
	 * Downloads an IPS item to the given destination.
	 *
	 * @param {{url: string, id: number, category: string}} file
	 * @param {string} destFolder Destination folder
	 * @param {{allFiles: boolean, filename: string}} [opts] Options.
	 * @returns {Promise.<{string}[]>} Paths to downloaded files
	 * @private
	 */
	_downloadItem(file, destFolder, opts) {

		opts = opts || {};
		let cachedFile = _.find(this._getFileCache(file.category), { id: file.id });
		if (!cachedFile) {
			return Promise.reject(new Error('Must provide a file retrieved from #getFiles(), #findFiles() or #findFile().'));
		}
		if (cachedFile.filename && fs.existsSync(resolve(destFolder, cachedFile.filename))) {
			this.logger.info('Skipping existing file "%s"...', cachedFile.filename);
			return Promise.resolve([{ path: resolve(destFolder, cachedFile.filename) }]);
		}

		let delay = Math.floor(Math.random() * ( opts.maxDelay - opts.minDelay + 1)) + opts.minDelay;
		return Promise.delay(delay).then(() => {
			return this._getDownloadUrl(cachedFile);

		}).then(downloadUrl => {
			this._saveFileCache();

			// fetch "file list" page
			return this._prepareDownload({ url: downloadUrl, jar: this._ips._cookieJar });

		}).spread((readStream, body, filename) => {

			// no body means a stream, so download file.
			if (!body) {
				cachedFile.filename = filename;
				return this._streamFile(readStream, filename, destFolder).then(path => [ { path: path } ]);
			}

			// check status code
			let response = readStream;
			if (response.statusCode === 404) {
				this.logger.warn('Looks like this file is not available anymore, skipping.');
				return Promise.resolve([cachedFile.filename]);
			}
			if (response.statusCode !== 200) {
				throw new Error('Status code is ' + response.statusCode + ' instead of 200 when downloading confirmation page.');
			}

			// can be multiple, they are sorted by date ascending, so latest is last item.
			let availableFiles = this._parseFileList(cheerio.load(body));
			if (_.isEmpty(availableFiles)) {
				throw new Error('Could not parse file names from download page.');
			}
			cachedFile.listing = availableFiles;
			this._saveFileCache();

			let filesToDownload = [];
			if (opts.allFiles) {
				filesToDownload = availableFiles;

			} else if (opts.filename) {
				let file = _.find(availableFiles, file => file.filename === opts.filename);
				if (!file) {
					throw new Error('File "' + opts.filename + '" is not available. Available files: [ ' + availableFiles.map(f => f.filename).join(', ') + ' ].');
				}
				filesToDownload.push(file);

			} else {
				filesToDownload.push(availableFiles[0]);
			}

			let localPaths = [];
			return Promise.each(filesToDownload,
				fileToDownload => this._downloadFile(cachedFile, fileToDownload, destFolder)
					.then(path => localPaths.push({ path: path }))
			);
		});
	}

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
	_prepareDownload(options) {

		return new Promise((resolve, reject) => {

			this.logger.info('--> GET %s', options.url);
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
						this.logger.warn('Messed up Content-Disposition "%s", taking whole string "%s".', response.headers['content-disposition'], filename);
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
	}

	/**
	 * Streams a request object's data to a file.
	 *
	 * Note that we assume that the stream is paused due to a general
	 * streams issue.
	 *
	 * @param {Stream} readStream Request stream
	 * @param {string} filename File name as in HTTP header
	 * @param {string} destFolder Local destination folder
	 * @returns {Promise.<string>} Local path to saved file
	 * @private
	 */
	_streamFile(readStream, filename, destFolder) {

		const started = new Date().getTime();
		const dest = resolve(destFolder, filename);
		if (fs.existsSync(dest)) {
			readStream.destroy();
			this.logger.info('File already exists in destination, skipping.');
			return Promise.resolve(dest);
		}

		return new Promise((resolve, reject) => {

			this.logger.info('Streaming to %s...', dest);
			var writeStream = fs.createWriteStream(dest);
			writeStream.on('close', () => {

				var fd = fs.openSync(dest, 'r');
				var size = fs.fstatSync(fd).size;
				fs.closeSync(fd);

				this.logger.info('Downloaded %d bytes to %s in %d seconds.', size, dest, (new Date().getTime() - started) / 1000);
				resolve(dest);

			}).on('error', reject);
			readStream.on('error', reject);
			readStream.resume();
			readStream.pipe(writeStream);
		});
	}

	/**
	 * Returns all cached categories or an empty array if nothing cached.
	 *
	 * @returns {{label: string, url: string, id: number}[]} Cached categories
	 * @private
	 */
	_getCategoryCache() {

		if (this._categoryCache) {
			return this._categoryCache;
		}
		if (!fs.existsSync(this._categoryCachePath)) {
			return [];
		}
		return this._categoryCache = JSON.parse(fs.readFileSync(this._categoryCachePath));
	}

	/**
	 * Returns all cached files or an empty array if nothing cached.
	 *
	 * @param {string} categoryId ID of the category
	 * @returns {{url: string, id: number, title: string, description: string, views: number, author: string, category: string}[]} Cached files
	 * @private
	 */
	_getFileCache(categoryId) {

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
	}

	/**
	 * Saves updated files back to cache.
	 *
	 * If both parameters are set, files of given category are replaced.
	 *
	 * @param {string} [categoryId]
	 * @param {{url: string, id: number, title: string, description: string, views: number, author: string, [category]: number}[]} [files]
	 * @private
	 */
	_saveFileCache(categoryId, files) {

		this._fileCache = this._fileCache || {};
		if (categoryId && files) {
			this._fileCache[categoryId] = files;
		}
		fs.writeFileSync(this._fileCachePath, JSON.stringify(this._fileCache, null, '\t'));
	}

	/**
	 * Returns a regex from a search query.
	 * @param query Search query
	 * @returns {RegExp}
	 */
	static getSearchRegex(query) {
		return new RegExp(query.replace(/[^a-z0-9\s_-]+/gi, '').replace(/\s+/, '.*?'), 'i');
	}

	/**
	 * Returns a function that matches a file for a given query.
	 * @param {string} query
	 * @returns {Function} Match function
	 */
	static matchFile(query) {
		var regex = this.getSearchRegex(query);
		return function(file) {
			return regex.test(file.title) || regex.test(file.description)
		}
	}
};