#!/usr/bin/env node

var apiHost = 'api.layervault.com',
    Client = require('node-rest-client').Client,
    apiClient = new Client(),
    args = process.argv.slice(2),
    http = require('http'),
    token,
    Q = require('q'),
    fs = require('fs'),
    path = require('path'),
    mkdirp = require('mkdirp'),
    _ = require('lodash'),
    strftime = require('strftime'),
    request = require('request'),
    folderName = strftime('%Y%m%d-%H%M%S'),
    startFolder = 'out/' + folderName,
    maxIdsPerRequest = 200;

if(args.length < 4){
  console.log('You forgot to include your LayerVault Username, password, Client ID and Secret');
  process.exit(1);
}

var treeObjects = {};

authenticate(args[0], args[1], args[2], args[3])
  .then(function(token){

    // ***
    // Start fetchin'
    // Start with the "me" call and read all levels of data into memory
    // This will allow us to get away with only a handful of API calls and should keep us
    // under the limit.
    // ***
    console.log("Starting fetch");
    get(token, 'me')
      // Users
      .then(function(data){

        var level = {
          nodes: _.indexBy(data.users, 'id'),
          getChildren: function(n){ return n.links.organizations; }
        };

        return fetchNextLevel(token, level, 'organizations');
      })
      // Organizations
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          childrenKey: 'projects',
          getChildren: function(n){ return n.links.projects; }
        };

        treeObjects['organizations'] = level;

        return fetchNextLevel(token, level, 'projects');
      })
      // Projects
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          childrenKey: 'folders',
          getChildren: function(n){ return n.links.folders; }
        };

        treeObjects['projects'] = level;

        return fetchNextLevel(token, level, 'folders');
      })
      // Folders
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          childrenKey: 'files',
          getChildren: function(n){ return n.links.files; }
        };

        treeObjects['folders'] = level;

        return fetchNextLevel(token, level, 'files');
      })
      // Files
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.slug; },
          childrenKey: 'revision_clusters',
          getChildren: function(n){ return n.links.revision_clusters; }
        };

        treeObjects['files'] = level;

        return fetchNextLevel(token, level, 'revision_clusters');
      })
      // Revision Clusters
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return 'cluster-' + n.cluster_number; },
          childrenKey: 'revisions',
          getChildren: function(n){ return n.links.revisions; }
        };

        treeObjects['revision_clusters'] = level;

        return fetchNextLevel(token, level, 'revisions');
      })
      // Revisions
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return 'revision-' + n.revision_number; },
          postProcessNode: function(n, p){
            // *** download the file here!
            console.log('Fetching: ' + n["download_url"]);
            var requestOptions = {
              url: n["download_url"],
              headers: {
                'Authorization': 'Bearer ' + token.token['access_token']
              }
            };
            var r = request(requestOptions);
            r.on('response',  function (res) {
              if(res.headers['status'] === '404 Not Found'){
                console.log("Not Found: " + n["download_url"]);
                return;
              }
              var fileName = getFileNameFromHeader(res);
              console.log('Writing: ' + fileName);
              res.pipe(fs.createWriteStream(p + '/' + fileName));
            });
          }
        };

        treeObjects['revisions'] = level;

        postProcess(treeObjects);
      })
      .catch(handleError);
  })
  .catch(handleError);

function postProcess(treeObjects){
  console.log('Starting post process');

  mkdirp.sync('out');
  mkdirp.sync(startFolder);

  // Depth first tree traversal
  _.values(treeObjects['organizations'].nodes).forEach(function(node){
    processNode(treeObjects['organizations'], node, startFolder);
  });
}

function processNode(level, node, startPath){

    var path = startPath + '/' + level.folderName(node);
    mkdirp.sync(path);
    fs.writeFileSync(path + '/meta.json', JSON.stringify(node, null, 2));

    // If there is a special node process call back
    if(level.postProcessNode){
      level.postProcessNode(node, path);
    }

    // If has children, process them recursively
    if(level.childrenKey){
      level.getChildren(node).forEach(function(child){
        processNode(treeObjects[level.childrenKey], treeObjects[level.childrenKey].nodes[child], path);
      });
    }
}

function fetchNextLevel(token, currentLevel, childApiMethod){

  var deferred = Q.defer();

  var allChildren = _.flatten(_.values(currentLevel.nodes).map(currentLevel.getChildren));

  var chunkPromises = _.chunk(allChildren, maxIdsPerRequest).map(function(ids){
    var childIds = ids.join(',');
    console.log("Fetching " + childApiMethod + ": " + ids);

    return get(token, childApiMethod + '/${ids}', {'ids': ids});
  });

  Q.all(chunkPromises).then(function(results){

    var flattened = _.flatten(results.map(function(r){
      return r[childApiMethod];
    }));

    deferred.resolve(flattened);
  })
  .catch(handleError);

  return deferred.promise;
}

// ***
// Helper function to access api methods
// ***
function get(token, method, path, parameters){

  var deferred = Q.defer();

  var headers = {
    'Authorization': 'Bearer ' + token.token['access_token']
  };

  apiClient.get('https://' + apiHost + '/api/v2/' + method,
  {
    headers: headers,
    path: path,
    parameters: parameters
  }, function(data, response){

    if(response.statusCode != 200){
      console.log("Error: " + response.statusCode + " on method: " + method);
      deferred.reject();
    }

    if(!data){
      console.log("Error: Empty data response on method: " + method);
      deferred.reject();
    }

    var obj = JSON.parse(data);

    deferred.resolve(obj);
  });

  return deferred.promise;
}

function authenticate(user, password, clientId, clientSecret){

  var deferred = Q.defer();

  var oauth2 = require('simple-oauth2')({
    clientID: clientId,
    clientSecret: clientSecret,
    site: 'https://' + apiHost,
    tokenPath: '/oauth/token'
  });

  // Get the access token object for the client
  oauth2.password.getToken({ username: user, password: password}, authenticated);

  function authenticated(error, result) {
    if (error) {
      console.log('Access Token Error', error.message);
      deferred.reject(error);
    }

    // Set token for use elsewhere in the app
    token = oauth2.accessToken.create(result);
    deferred.resolve(token);
  }

  return deferred.promise;
}

function handleError(error){
  console.log(error);
}

function getFileNameFromHeader(response){
  var regexp = /.*?\'\'(.*)/i;

  var match = regexp.exec( response.headers['content-disposition'] );
  if(!match || match.length < 2){
    console.log(response.headers);
    return "fileWithUnknownName";
  }
  return match[1];
}
