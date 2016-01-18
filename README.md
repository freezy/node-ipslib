# ipblib

A library for accessing IPS Community boards through a neat API.

### Usage

Instantiate with name and URL, then access modules through object. All
functions return a Promise.

```javascript
const Ipb = require('ipblib');
const ipb = new Ipb("mxboard", "http://www.myboard.com");
ipb.downloads.getCategories().then(result => {
	console.log("Got results:");
	console.log(result);
});
```

### License

GPLv3