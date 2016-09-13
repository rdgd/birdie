#!/usr/bin/env node
'use strict';

// TODO: option in case of error to either rollback with down methods from start or just migrate as far as possible (default)
// TODO: option to pass existing db connection, so that the user may avoid configuration overhead

var cli = require('commander');
var chalk = require('chalk');
var fs = require('fs');
var mongo = require('mongodb');
var MongoClient = mongo.MongoClient;
var isCLI = require.main === module;
var defaults = require('./defaults');
var postMigrate;
var c;

cli
  .option('-e, --environment [string]', 'Environment to run migrations in')
  .option('-d, --directory [string]', 'Directory which contains migrations to run')
  .option('-m, --migration [int]', 'Target migration level')
  .option('-c, --config [string]', 'Path to config file')
  .option('-r, --rollback', 'Revert to last migration')
  .option('-p, --partial', 'Allow partial migration on failure. This is default behaviour. If set to false, then Birdie will attempt to rollback any changes made.')
  .parse(process.argv);

if (isCLI) { configure(); }

function configure (config, callback) {
  let configFilePath = cli.config ? cli.config : 'birdie.config.js';
  config = isCLI ? require(process.cwd() + '/' + configFilePath) : config;
  c = config;
  // Allows user to put migration data in the top level of the object, OR nest it in the environments object
  if (config.environments) {
    if (config.environments[cli.environment]) {
      config = config.environments[cli.environment];
    }
  } else {
    // Assigning top level db connection information since there is not environments array in user config
    for (let prop in defaults.db) {
      if (!c.db[prop] && c.db[prop] !== '') {
        c.db[prop] = defaults.db[prop];
      }
    }
  }

  if (cli.directory) { c.directory = cli.directory; }
  if (!c.directory) { c.directory = defaults.directory; }
  if (cli.migration) { c.migration = cli.migration; }

  let connectionString = makeConnectionString(config.db.username, config.db.password, config.db.host, config.db.port, config.replica.host, config.replica.host_port, config.db.name, config.replica.set);
  postMigrate = callback;
  connect(connectionString, config.mongo);
}

function connect (connectionString, mongoConfig) {
  console.log(chalk.cyan(`Connecting to ${connectionString}`));
  MongoClient.connect(connectionString, mongoConfig, function (err, db) {
    if (err) {
      console.log(chalk.red(`Could not establish a database connection`));
      return exitIfCLI(1);
    }

    console.log(chalk.green('Connected'));
    main(db);
  });
};

function main (db) {
  getMigrations(db)
    .then(createMigrationsCollectionIfNotExists.bind(null, db))
    .then(runMigrationsIfNeeded.bind(null, db))
    .catch(function (err) {
      console.log(err);
      return exitIfCLI(1);
    });
}

function runMigrationsFromTo (db, f, t) {
  if (t < 0) {
    console.log(chalk.red('Your target migration must have an ID greater than or equal to 1'));
    return exitIfCLI(1);
  }

  let method = f < t ? 'up' : 'down';
  let dir = process.cwd() + '/' + c.directory;
  // Normalize, make sure it always ends with a forward slash
  if (dir[dir.length + 1] !== '/') { dir += '/'; }

  fs.readdir(dir, function (err, files) {
    if (err) {
      console.log(chalk.red(`Could not read from the directory "${dir}"`));
      return exitIfCLI(1);
    }

    if (files.length === 0) {
      console.log(chalk.red(`No files were found in the migrations directory`));
      return exitIfCLI(1);
    }

    let migrationsToRun = [];
    let filesString = files.join();
    let checkingMsg = Math.abs(f - t) === 1 ? ` ${f} exists` : `s ${f} to ${t} exist`;

    console.log(chalk.green(`Migrations directory found`));
    console.log(chalk.cyan(`Checking that files for migration${checkingMsg}`));

    if (f < t) {
      console.log(f);
      for (let i = (parseInt(f) + 1); i <= t; i++) { migrationsToRun.push(getMigrationById(i, files)); }
    } else {
      /*
        We don't set i equal to f minus one because in this case we need to run the down method, unlike up, but we need to stop short
        so that we don't execute the down method of the target migration level
      */
      for (let i = f; i > t; i--) { migrationsToRun.push(getMigrationById(i, files)); }
    }

    console.log(chalk.green(`Migration files found`));

    migrate(migrationsToRun);
    function migrate (arr) {
      if (arr.length === 0) {
        console.log(chalk.green(`All migrations completed successfully`));
        setMigrationLevel(db, t, f);
        console.log(chalk.green(`Updated migrations collection successfully`));
        if (postMigrate) {
          return postMigrate(db.close);
        } else {
          return db.close();
        }
      }
      let p = arr[0].path;
      let mi = require(dir + p);

      // Find migration file corresponding to number
      console.log(chalk.cyan(`Running migration ${p}`));
      validateMigration(mi);

      try {
        mi[method](db, function () {
          arr.shift();
          migrate(arr);
        });
      } catch (err) {
        if (err) {
          // Otherwise we get current and previous as the same!
          if (arr[0].id !== f) {
            setMigrationLevel(db, arr[0].id, f);
          }
          console.log(chalk.red(err));
          return exitIfCLI(1);
        }
      }
    }
  });
}

function getMigrations (db) {
  let migrations = db.collection('migrations');
  return migrations.find().toArray();
}

function createMigrationsCollectionIfNotExists (db, m) {
  if (m.length === 0) {
    console.log(chalk.yellow('No migrations collection found... creating one now'));
    let migrations = db.collection('migrations');
    let mCreated = migrations.insertOne({ current: 1, previous: 0 });
    if (!mCreated) { throw 'Could not create migrations collection, please check permissions and try again!'; }
    console.log('Migrations collection created');
    return m;
  } else {
    console.log(chalk.green('Migrations collection found'));
    return m;
  }
}

function runMigrationsIfNeeded (db, m) {
  if (m[0].current === c.migration) {
    console.log(chalk.green('No migrations to run, you are all up to date!'));
    if (postMigrate) {
      postMigrate(db.close);
    } else {
      db.close();
    }
    return exitIfCLI(0);
  } else {
    runMigrationsFromTo(db, m[0].current, c.migration);        
  }
}

function getMigrationById (i, files) {
  let migration = false;
  let fileName;

  for (let x = 0; x < files.length; x++) {
    migration = new RegExp(`${i}_`).test(files[x]);
    if (migration) {
      migration = { path: files[x], id: i };
      break;
    }
  }

  if (!migration) {
    console.log(chalk.red(`The corresponding file for migration ${i} was not found!`));
    console.log(chalk.red(`Make sure the file exists and that it is named according to the documentation.`));
    exitIfCLI(1);
  }

  return migration;
}

function makeConnectionString (user, pass, host, port, rHost, rPort, dbName, rSet) {
  var connectionString = 'mongodb://';
  var hasReplicaSet = (rHost && rPort && rSet) || false;

  if (user && pass) {
    connectionString += `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  }
  connectionString += `${host}:${port}`;
  connectionString += hasReplicaSet ? `,${rHost}:${rPort}/${dbName}?replicaSet=${rSet}` : `/${dbName}`;

  return connectionString;
}

function validateMigration (mi) {
  let msg = false;
  if (!mi.up) { msg = `You must export an up method for every migration.`; } 
  if (!mi.down) { msg = `You must export a down method for every migration.`; }
  if (msg) { console.log(chalk.red(msg)); }

  return msg ? exitIfCLI(1) : true;
}

function setMigrationLevel (db, curr, prev) {
  db.collection('migrations').updateOne({}, { $set: { current: curr, last: prev } });
}

function exitIfCLI (code) {
  if (isCLI) { process.exit(code); }
  return isCLI;
}

module.exports = configure;