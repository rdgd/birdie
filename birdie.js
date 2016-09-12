/*
  TODO: multiple environments and mongo options
  TODO: option in case of error to either rollback with down methods from start or just migrate as far as possible (default)
*/

var chalk = require('chalk');
var fs = require('fs');
var mongo = require('mongodb');
var MongoClient = mongo.MongoClient;
var isCLI = require.main === module;
var postMigrate;
var c;

if (isCLI) { connect(); }

function connect (callback, config) {
  c = isCLI ? require(process.cwd() + '/birdie.config.js') : config;
  let connectionString = makeConnectionString(c.db.username, c.db.password, c.db.host, c.db.port, c.replica.host, c.replica.host_port, c.db.name, c.replica.set);
  postMigrate = callback;
  console.log(chalk.cyan(`Connecting to ${connectionString}`));
  MongoClient.connect(connectionString, c.mongo, function (err, db) {
    if (err) {
      console.log(chalk.red(`Could not establish a database connection`));
      return exitIfCLI(1);
    }

    console.log(chalk.green('Connected'));
    main(db);
  });
};

function main (db) {
  let migrations = db.collection('migrations');
  // Check if migrations collection exists. If not, create it
  migrations.find().toArray()
    .then(function (m) {
      if (m.length === 0) {
        console.log(chalk.yellow('No migrations collection found... creating one now'));
        let mCreated = migrations.insertOne({ current: 1, previous: 0 });
        if (!mCreated) { throw 'Could not create migrations collection, please check permissions and try again!'; }
        console.log('Migrations collection created');
        return m;
      } else {
        console.log(chalk.green('Migrations collection found'));
        return m;
      }
    })
    .then(function (m) {
      if (m[0].current === c.migration) {
        console.log(chalk.green('No migrations to run, you are all up to date!'));
        if (postMigrate) { postMigrate(); }
        return exitIfCLI(0);
      } else {
        runMigrationsFromTo(db, m[0].current, c.migration);        
      }
    })
    .catch( function (err) {
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
  let dir = process.cwd() + '/' + c.dir;
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

    function findMigration (i) {
      let migrationFound = false;
      let fileName;
      for (let x = 0; x < files.length; x++) {
        migrationFound = new RegExp(`${i}_`).test(files[x]);
        if (migrationFound) {
          migrationsToRun.push({ path: files[x], id: i });
          break;
        }
      }

      if (!migrationFound) {
        console.log(chalk.red(`The corresponding file for migration ${i} was not found!`));
        console.log(chalk.red(`Make sure the file exists and that it is named according to the documentation.`));
        exitIfCLI(1);
      }

      return migrationFound;
    }

    if (f < t) {
      for (let i = (f + 1); i <= t; i++) {
        findMigration(i);
      }
    } else {
      /*
        We don't set i equal to f minus one because in this case we need to run the down method, unlike up, but we need to stop short
        so that we don't execute the down method of the target migration level
      */
      for (let i = f; i > t; i--) {
        findMigration(i);
      }
    }

    console.log(chalk.green(`Migration files found`));

    /*
      Yes, looping over the files twice is less efficient, but the number of files will always be trivial, and
      in the grand scheme of things, not having to try to run possibly broken "down" methods is safer.
    */
    for (let i = 0; i < migrationsToRun.length; i++) {
      // Find migration file corresponding to number
      console.log(chalk.cyan(`Running migration ${migrationsToRun[i].path}`));
      let mi = require(dir + migrationsToRun[i].path);
      if (!mi.up) {
        console.log(chalk.red(`You must export an up method for every migration.`));
        return exitIfCLI(1);
      } 
      if (!mi.down) {
        console.log(chalk.red(`You must export a down method for every migration.`));
        return exitIfCLI(1);
      } 
      try {
        mi[method](db);
      } catch (err) {
        if (err) {
          // Otherwise we get current and previous as the same!
          if (migrationsToRun[i].id !== f) {
            setMigrationLevel(db, migrationsToRun[i].id, f);
          }
          console.log(chalk.red(err));
          return exitIfCLI(1);
        }
      }
    }

    console.log(chalk.green(`All migrations completed successfully`));
    setMigrationLevel(db, t, f);
    console.log(chalk.green(`Updated migrations collection successfully`));
    if (postMigrate) { postMigrate(); }
    db.close();
  });
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

function setMigrationLevel (db, curr, prev) {
  db.collection('migrations').updateOne({}, { $set: { current: curr, previous: prev } });
}

function exitIfCLI (code) {
  if (isCLI) { process.exit(code); }
  return isCLI;
}

module.exports = connect;