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
ips.downloads.getCategories().then(result => {
	console.log("Got results:");
	console.log(result);
});
```

### API

See code documentation.

### License

GPLv3