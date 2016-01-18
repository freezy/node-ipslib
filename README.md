# ipslib

A JavaScript library for accessing IPS Community boards through a neat API.


### Usage

It's not published on npmjs.org, so you'll have to reference it through
GitHub directly:

	npm install --save freezy/node-ipslib


### Example
	
Instantiate with name and URL, then access modules through object. All
functions return a Promise.

```javascript
const Ips = require('node-ipslib');
const ips = new Ipb("myboard", "http://www.myboard.com");

// search files containing "sunset" in first category that matches "landscapes"
ips.downloads.findCategory('landscapes')
	.then(cat => ips.downloads.findFiles('sunset', cat))
	.then(console.log);
```

### Caching

Board index is saved at `~/.ipslib`. Use the `forceRefresh` option if you want
to rebuild the index.


### Authentication

When accessing protected resources, ipslib will automatically try to login and
keeps the session open, even across re-launches. If you want to logout at the
and of a session, you'll need to logout explicitly using `Ips#logout()`.


### API

See code documentation.


### License

GPLv3