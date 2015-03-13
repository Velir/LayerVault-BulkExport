#!/usr/bin/env node

var apiHost = 'api.layervault.com',
    Client = require('node-rest-client').Client,
    apiClient = new Client(),
    args = process.argv.slice(2),
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
    maxIdsPerRequest = 400,
    testingLimit;

if(args.length < 4){
  console.log('You forgot to include your LayerVault Username, password, Client ID and Secret');
  process.exit(1);
}

if(args.length > 4){
  testingLimit = +args[4];
}

var treeObjects = {};

/**
 * First authenticate
 */
authenticate(args[0], args[1], args[2], args[3])
  .then(function(token){

    /**
     * Start fetchin'
     * Start with the "me" call and read all levels of data into memory
     * This will allow us to get away with only a handful of API calls and should keep us
     * under the limit.
     */
    console.log("Starting fetch");
    get(token, 'me')
      // Users
      .then(function(data){

        var level = {
          nodes: _.indexBy(data.users, 'id'),
          key: 'users',
          childrenKey: 'organizations'
        };

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Organizations
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          key: 'organizations',
          childrenKey: 'projects'
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Projects
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          key: 'projects',
          childrenKey: 'folders'
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Folders
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.name; },
          key: 'folders',
          childrenKey: 'files'
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Files
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return n.slug; },
          key: 'files',
          childrenKey: 'revision_clusters'
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Revision Clusters
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return 'cluster-' + n.cluster_number; },
          key: 'revision_clusters',
          childrenKey: 'revisions'
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Revisions
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){ return 'revision-' + n.revision_number; },
          key: 'revisions',
          childrenKey: 'previews',
          postProcessNode: function(n, p){

            // *** download the file here!
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
              res.pipe(fs.createWriteStream(p + '/' + fileName));
            });
          }
        };

        treeObjects[level.key] = level;

        return fetchNextLevel(token, _.values(level.nodes), level.childrenKey);
      })
      // Previews
      .then(function(data){

        var level = {
          nodes: _.indexBy(data, 'id'),
          folderName: function(n){
            return 'preview - ' + n.page_number + (n.name ? ' - ' + n.name : ''); 
          },
          key: 'previews',
          postProcessNode: function(n, p){

            // *** download the preview here!
            var requestOptions = {
              url: n["url"],
              headers: {
                'Authorization': 'Bearer ' + token.token['access_token']
              }
            };

            var r = request(requestOptions);
            r.on('response',  function (res) {
              if(res.headers['status'] === '404 Not Found'){
                console.log("Not Found: " + n["url"]);
                return;
              }
              var fileName = "preview.png";
              res.pipe(fs.createWriteStream(p + '/' + fileName));
            });
          }
        };

        treeObjects[level.key] = level;

        postProcess(treeObjects);
      })
      .catch(handleError);
  })
  .catch(handleError);

/**
 * Starts post processing of nodes. Should be called after all
 * node levels are loaded from the API
 * @param treeObjects All of the tree objects fetched from the API keyed by type
 */
function postProcess(treeObjects){
  console.log('Starting post process');

  mkdirp.sync('out');
  mkdirp.sync(startFolder);

  // Depth first tree traversal
  _.values(treeObjects['organizations'].nodes).forEach(function(node){
    processNode(treeObjects['organizations'], node, startFolder);
  });
}

/**
 * Recursive method for processing each node in the tree
 * Folders are created on disk and the contents of the node are written to the folder
 * The node tree is traversed depth first
 *
 * @param level     The current level object
 * @param node      The node to process
 * @param startPath The current file path on disk for writing data
 */
function processNode(level, node, startPath){

    var path = startPath + '/' + level.folderName(node);
    mkdirp.sync(path);
    fs.writeFileSync(path + '/meta.json', JSON.stringify(node, null, 2));

    // If there is a special node process call back
    if(level.postProcessNode){
      level.postProcessNode(node, path);
    }

    // Process children of same name (i.e. folders)
    if(level.key && node.links[level.key]){
      node.links[level.key].forEach(function(child){
        if(treeObjects[level.key].nodes[child]){
          processNode(treeObjects[level.key], treeObjects[level.key].nodes[child], path);
        }
      });
    }

    // If has children, process them recursively
    if(level.childrenKey && node.links[level.childrenKey]){
      node.links[level.childrenKey].forEach(function(child){
        if(treeObjects[level.childrenKey].nodes[child]){
          processNode(treeObjects[level.childrenKey], treeObjects[level.childrenKey].nodes[child], path);
        }
      });
    }
}

/**
 * Fetches the next level of data in the hierarchy from the API
 * @param token               The oauth2 token
 * @param currentLevelNodes   The current level nodes
 * @param childLevelKey       The key for the child level
 * @return                    A promise of the next level API objects
 */
function fetchNextLevel(token, currentLevelNodes, childLevelKey){

  var deferred = Q.defer();

  var allChildren = _.flatten(currentLevelNodes.map(function(n){
    return n.links[childLevelKey];
  })).filter(function(child){
    return child;
  });

  // If there are no children, return an empty array
  if(!allChildren || allChildren.length === 0){
    deferred.resolve([]);
    return deferred.promise;
  }

  // If we want to limit the number of requests for testing purposes
  if(testingLimit){
    allChildren = allChildren.slice(0, testingLimit);
  }

  var chunkPromises = _.chunk(allChildren, maxIdsPerRequest).map(function(ids){
    var childIds = ids.join(',');
    console.log("Fetching " + childLevelKey + ": " + ids);

    return get(token, childLevelKey + '/${ids}', {'ids': ids});
  });

  Q.all(chunkPromises).then(function(results){

    var flattened = _.flatten(results.map(function(r){
      return r[childLevelKey];
    }));

    // Recursively fetch more levels of this type of node as needed (for folders, etc.)
    fetchNextLevel(token, flattened, childLevelKey)
      .then(function(data){
        deferred.resolve(flattened.concat(data));
      });
  })
  .catch(handleError);

  return deferred.promise;
}

/**
 * Helper function to access api methods
 * @param  token      The oauth2 token
 * @param  method     The API method
 * @param  path       The path parameters (usually just {'ids': ...})
 * @return            A promise of the API response as an object
 */
function get(token, method, path){

  var deferred = Q.defer();

  var headers = {
    'Authorization': 'Bearer ' + token.token['access_token']
  };

  apiClient.get('https://' + apiHost + '/api/v2/' + method,
  {
    headers: headers,
    path: path
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

/**
 * Authenticate the user
 * @param  user         The user name
 * @param  password     The password
 * @param  clientId     The client_id token
 * @param  clientSecret The client_secret token
 * @return              A promise of the oauth2 token
 */
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

/**
 * Generic deferred error handler
 * @param error The error opject
 */
function handleError(error){
  console.log(error);
}

/**
 * Parses the file name from the Content-Disposition header tag
 * @param response The file download response.
 */
function getFileNameFromHeader(response){
  var regexp = /.*?\'\'(.*)/i;

  var match = regexp.exec( response.headers['content-disposition'] );
  if(!match || match.length < 2){
    console.log(response.headers);
    return "fileWithUnknownName";
  }
  return match[1];
}
