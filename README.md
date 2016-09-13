# Birdie
A dead simple database migration tool for MongoDB. Birdie was created because even though MongoDB is incredibly flexible and thus allows you to often forgoe the need to make formal changes to the schema or the data en masse, that simply won't do in my opinion! I don't want to version my data, because that is sloppy, and I don't want to sully my application code with unnecessary logic, when I could just update some documents.

Enter Birdie. Birdie is a no frills (nor thrills) approach to handling database migrations with MongoDB. You can use its CLI or you can import it an use it in your source code (I recommending every time you boot your app server).

# Configuration
You can create a `birdie.config.js` file to use in the same directory as the command was issued, or name it something else and use a command line option below to let Birdie know about it.

The `birdie.config.js` file should be tracked in your source control, so that you can associate changes in your database with changes in your source code.

Here's an example `birdie.config.js` which only has one environment:

```
module.exports = {
  migration: 4,
  directory: 'migrations/',
  db: {
    name: 'birdy',
    host: 'localhost',
    port: 27017,
    username: '',
    password: '',
  },
  replica: {},
  mongo: {
    server: {
      poolSize: 10,
      socketOptions: {
        connectTimeoutMS: 3600000,
        keepAlive: 3600000,
        socketTimeoutMS: 3600000
      }
    }
  }
};
```

Here's an example of a multi-environment `birdie.config.js` file PLUS it has replica set configuration:

```
module.exports = {
  migration: 4,
  directory: 'migrations/',
  environments: {
    local: {
      db: {
        name: 'birdy',
        host: 'localhost',
        port: 27017,
        username: '',
        password: '',
      },
      replica: {},
      mongo: {}
    },
    prod: {
      db: {
        name: 'birdy-prod',
        host: 'myp.ro.du.c.t.ion.ip',
        port: 27017,
        username: 'root',
        password: 'lulz',
      },
      replica: {
        host: 'some.other.host', 
        host_port: 27017,
        set: 'rs-food0123'  // Passed to replicaSet GET param in connection string
      },
      mongo: {}
    }
  }
};
```

# Migration Files

Migration files must live in the directory specified by the config, and they must follow the following naming convention: The migration ID should be the first part of the migration filename, separated by the rest of the filename by an underscore. For example `0257_renamed_documents_collection.js`.

Migration files must export two functions, named `up` and `down` respectively. Each of these functions receives two arguments from birdie, (1) mongodb instance and (2) a "done" method you must call when you are done with all of your asynchronous operations.

Here is an example migration file:

```
module.exports = {
  up: function (db, done) {
    db.createCollection('fiddlesticks').then(function (collection) {
      console.log('Collection was created!');
      done();
    }).catch(function (err) {
      console.log(err);
    });;
  },
  down: function (db, done) {
    db.collection('fiddlesticks').drop(function (err, reply) {
      done();
    });
  }
}
```

# Usage

The command `birdie` run in the same directory as a complete `birdie.config.js` file will work.

When running Birdie in your NodeJS application as a module, simply do something like the following

```
var birdie = require('birdie');
var config = require('./birdie.config'); // So long as it lives in the same directory

function startTheApp () {
  // The stuff you normally do to boot your application server here
}

birdie(config, startTheApp);

```

On top of the configuration file (detailed above) and the basic argument-less usage, there are a number of options you can specify at the time of running the birdie command from the command line. For a list of available CLI options `birdie --help`