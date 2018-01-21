var express = require("express");
var fs = require("fs");
var request = require("request");
var cheerio = require("cheerio");
var app = express();
var mongoClient = require('mongodb').MongoClient;
var dbURL = 'mongodb://localhost:27017/owstats';
var CURRENT_SEASON = 3;

// Enable CORS
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});


// Connect to database
var mongoDB;
mongoClient.connect(dbURL, function(err, db) {
  if (err !== "null") {
    console.log("Connected successfully to Mongo DB");
    mongoDB = db;
  } else {
    console.log(err);
  }
});

// Service to retrieve all owstats and refreshed
app.get('/owstats', function(req, res)
{
  var url = 'https://www.overbuff.com/players/pc/Pikmet-1746?mode=competitive'
  
  refreshService(function(refreshed) {
    var wasRefreshed = JSON.parse(refreshed).updated;
    request(url, function(error, response, html) {
      if (!error) {
        var $ = cheerio.load(html);
        var json = {};

        json.Heroes = getHeroStats($); 
        json.Player = getPlayerStats($);
        json.Refreshed = wasRefreshed;
        json.Timestamp = new Date();
        json.Season = CURRENT_SEASON;

        res.send(json);

        if (wasRefreshed) { saveToDatabase(json); }
      }
    });
  });
});

// Starcraft Events
app.get('/sc2events', function(req, res)
{
  var url = "https://wcs.starcraft2.com/en-us/schedule/";
  
  request(url, function(error, response, html) {
    if (!error) {
      var $ = cheerio.load(html);
      var json = {};
      json.events = [];
      $(".eventCard-entry").each(function (i, element) {
        var eventObj = {};
        eventObj.name = $(element).find(".metaData-hd").children().first().text();
        eventObj.time = $(element).find(".eventCard-time").children().first().data("locale-time-timestamp");
        eventObj.details = $(element).find(".meta-Data-ft").children().first().text();
        eventObj.image = $(element).find(".eventCard-logo").children().first().attr("src");
        json.events.push(eventObj);
      });

      res.send(json);
    }
  });
});

// Service to refresh overbuff stats
app.get('/refresh', function(req, res)
{
  refreshService(function (body) {
    res.send(body);
  });
});

app.get('/skillrating', function(req, res)
{
  var data = [];
  mongoDB.collection('allStats', function(err, collection) {
    collection.find({}).toArray(function(err, list) {
      list.forEach(function (stat) {
        var timestamp = stat.Timestamp;
        var skillRating = stat.Player["Skill Rating"].trim();
        data.push([ timestamp, skillRating ]);
      });

      data = combineData(data);
      data.unshift([ "Time", "Skill Rating" ]);
      res.send(data);
    });
  });
});

app.get('/herostat', function(req, res)
{
  var hero = req.query.hero;
  var statName = req.query.stat.trim();

  var data = [];
  mongoDB.collection('allStats', function(err, collection) {
    collection.find({}).toArray(function(err, list) {
      list.forEach(function (stat) {
        var timestamp = stat.Timestamp;
        if (stat.Heroes[hero] && stat.Heroes[hero][statName]) 
        {
          var value = stat.Heroes[hero][statName].Value.trim();
          data.push([ timestamp, value ]);
        }
      });

      data = combineData(data);
      data.unshift([ "Time", statName ]);
      res.send(data);
    });
  });
});

app.listen('8080');

exports = module.exports = app;

var combineData = function(data) {
  var transformedData = [];
  data.map(function(row) {
    var date = new Date(row[0]);
    var value = row[1]; 
    var dateString = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
    transformedData[dateString] = value;
  });

  var data = [];
  for (var dateString in transformedData)
  {
    var curr = transformedData[dateString];
    data.push([dateString, curr]);
  }
  return data;
};

var averageData = function(data) {
  var transformedData = [];
  data.map(function(row) {
    var date = new Date(row[0]);
    var value = row[1]; 
    var dateString = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
   
    if (transformedData[dateString]) {
      transformedData[dateString].Sum += value;      
      transformedData[dateString].Count++;
    } else {
      transformedData[dateString] = {
        Sum: value,
        Count: 1
      };
    }
  });

  var data = [];
  for (var dateString in transformedData)
  {
    var curr = transformedData[dateString];
    data.push([dateString, (curr.Sum / curr.Count)]);
  }
  return data;
};

var refreshService = function(success) {
  var url = 'https://www.overbuff.com/players/pc/Pikmet-1746/refresh'

  request.post(url, {}, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      success(body);
    }
  });
}

var saveToDatabase = function(json) {
  var collection = mongoDB.collection('allStats');
  collection.insert(json, function (err, result) {
    if (!err) {
      console.log("Inserted new document at " + (new Date()));
    } else {
      console.log(err);
    }
  });
};

var getPlayerStats = function ($) {
  var playerStats = {};
  $(".layout-header-secondary").find("dl").each(function(i, stat) {
    var statElement = $(stat);

    var name = statElement.children().eq(1).text();
    var value = statElement.children().eq(0).text();

    playerStats[name] = value;
  });

  playerStats.Name = $(".layout-header-primary-bio").children().first().text().trim();

  return playerStats;
};

var getHeroStats = function ($) {
  var heroes = {};

  $(".player-hero").each(function (i, element) {
    var name = $(element).find(".name").children().first().text();
    // Replace accent in Lucio's name
    name = name.replace("ú","u");
    // Replace . in D.Va's name
    name = name.replace("."," ");

    var heroStats={};
    $(element).find('.stat').each(function(i, stat) {
      var statElement = $(stat);
      if (statElement.children().length > 2) {
        parseNormalStat(heroStats, statElement);
      } else if (statElement.children().length === 2) {
        parseSpecialStat(heroStats, statElement);
      }
    });


    heroes[name] = heroStats;
  });
  return heroes;
};

var parseSpecialStat = function (heroStats, statElement) {
  var statName = statElement.children().eq(1).text();
  var statValue = statElement.children().eq(0).text();

  heroStats[statName] = 
  {
    Value: statValue,
  };
};

var parseNormalStat = function (heroStats, statElement) {
  var statName = statElement.children().eq(2).text();
  var statValue = statElement.children().eq(0).text();
  var percentile = getHeroPercentile(statElement);
  var trend = getTrend(statElement);

  heroStats[statName] = 
  {
    Value: statValue,
    Percentile: percentile,
    Trend: trend
  };
};

var getTrend = function(statElement) {
  var image = statElement.find('i');
  if (image.length > 0) {
    var isPositive = image.hasClass("color-status-success");
    var isIncreasing = image.hasClass("fa-arrow-circle-o-up"); 
    var text = image.attr("title");
    return {
      IsIncreasing: isIncreasing,
      IsPositive : isPositive,
      Text : text
    }
  }
  return undefined;
};

var getHeroPercentile = function (statElement) {
  var titleText = statElement.find(".bar").attr("title");
  var regexPercentile = /(\d+).* Percentile/
  var match = regexPercentile.exec(titleText);
  if (match && match.length > 0) {
    return { Value: match[1], Text: titleText };
  }

  return "";
};
