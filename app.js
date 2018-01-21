var MongoClient = require('mongodb').MongoClient, assert = require('assert')

var url = 'mongodb://localhost:27017';

MongoClient.connect(url, function(err, db) {
  assert.equal(null, err);
  console.log("Connected successfully to server");

  db.close();
});
