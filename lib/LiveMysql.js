// pg-live-select, MIT License
var util = require('util');

var _ = require('lodash');
var ZongJi = require('zongji');
var mysql = require('mysql');

var LiveSelectBase = require('./LiveSelectBase');

// Maximum duration to wait for Zongji to initialize before timeout error (ms)
var ZONGJI_INIT_TIMEOUT = 1500;

function LiveMysql(settings, options) {
  var self = this;
  LiveSelectBase.call(self, options);

  var db = mysql.createConnection(settings);

  self.settings = settings;
  self.zongji = null;
  self.db = db;
  self.schemaCache = {};
  self.tablesUsedCache = {};

  self.zongjiSettings = {
    serverId: settings.serverId,
    startAtEnd: true,
    includeEvents: [ 'tablemap', 'writerows', 'updaterows', 'deleterows' ],
    includeSchema: self.schemaCache
  };

  self.db.connect(function(error){
    if(error) return self.emit('error', error);

    var zongji = self.zongji = new ZongJi(self.settings);

    zongji.on('error', function(error) {
      self.emit('error', error);
    });

    zongji.on('binlog', function(event) {
      var eventName = event.getEventName();
      var tableMap = event.tableMap[event.tableId];

      if(eventName === 'tablemap') return;

      var row;

      // TODO add support for tableMap.parentSchema matching!
      for(var r = 0; r < event.rows.length; r++){
        row = event.rows[r];
        if(eventName === 'updaterows') {
          self._matchRowEvent(tableMap.tableName, row.before, row.after);
        } else {
          // writerows or deleterows
          self._matchRowEvent(tableMap.tableName, row);
        }
      }

    });

    // Wait for Zongji to be ready before executing callback
    var zongjiInitTime = Date.now();
    var zongjiReady = function() {
      if(zongji.ready === true) {
        self.emit('ready');
      } else {
        // Wait for Zongji to be ready
        if(Date.now() - zongjiInitTime > ZONGJI_INIT_TIMEOUT) {
          // Zongji initialization has exceeded timeout, emit error
          self.emit('error', new Error('ZONGJI_INIT_TIMEOUT_OCCURED'));
        } else {
          setTimeout(zongjiReady, 40);
        }
      }
    };
    zongji.start(self.zongjiSettings);
    zongjiReady();
  });
}

util.inherits(LiveMysql, LiveSelectBase);
module.exports = LiveMysql;

LiveMysql.prototype._initSelect = function(queryHash, buffer, callback) {
  var self = this;

  buffer.triggers = buffer.triggers || {};

  if(typeof buffer.triggers !== 'object')
    return callback(new Error('triggers object required'));

  // Change Postgres style $1, $2... parameter arguments into ?, ?
  buffer.fixedQuery = buffer.query.replace(/\$\d+/g, '?');

  // Update schema included in ZongJi events
  var attachTriggers = function(foundTables) {

    // Add invalidation functions for tables determined automatically
    foundTables.forEach(function(foundTable) {
      if(!(foundTable in buffer.triggers)) {
        // Provide data invalidation function to refresh on any row change
        buffer.triggers[foundTable] = function(row) { return true };
      }
    });

    var includeSchema = self.schemaCache;
    Object.keys(buffer.triggers).forEach(function(triggerTable) {
      var triggerDatabase = self.settings.database;

      if(triggerDatabase === undefined)
        return callback(new Error('no database selected on trigger'));

      if(!(triggerDatabase in includeSchema)){
        includeSchema[triggerDatabase] = [ triggerTable ];
      }else if(includeSchema[triggerDatabase].indexOf(triggerTable) === -1){
        includeSchema[triggerDatabase].push(triggerTable);
      }
      // TODO add support for triggerDatabase matching!
      if(!(triggerTable in self.allTablesUsed)) {
        self.allTablesUsed[triggerTable] = [ queryHash ];
      } else if(self.allTablesUsed[triggerTable].indexOf(queryHash) === -1) {
        self.allTablesUsed[triggerTable].push(queryHash);
      }
    });

    callback();
  };

  // Determine dependent tables, from cache if possible
  if(queryHash in self.tablesUsedCache) {
    attachTriggers(self.tablesUsedCache[queryHash]);
  } else {
    self._findDependentRelations(buffer.fixedQuery, buffer.params,
      function(error, result) {
        if(error) return callback(error);
        self.tablesUsedCache[queryHash] = result;
        attachTriggers(result);
      }
    );
  }

}

// XXX: Will not work with aliased table names because MySQL EXPLAIN
//      outputs table alias instead of table name
LiveMysql.prototype._findDependentRelations = function(query, params, callback) {
  var self = this;
  self.db.query('EXPLAIN ' + query, params, function(error, rows) {
    if(error) return callback(error);

    var tablesUsed = rows.map(function(row) {
      return row.table;
    });

    callback(undefined, tablesUsed);
  });
};

LiveMysql.prototype.cleanup = function(callback) {
  var self = this;
  self.zongji.stop();
  self.db.destroy();
  callback && callback();
};


LiveMysql.prototype._updateQuery = function(queryBuffer, callback) {
  var self = this;

  self.db.query(queryBuffer.fixedQuery, queryBuffer.params, function(error, rows) {
    if(error) return callback && callback(error);

    // Update process finished
    callback && callback(null, rows);
  });
}
