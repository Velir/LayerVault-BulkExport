#!/usr/bin/env node

/**
 * Dependencies
 */
var Client =    require('node-rest-client').Client,
    Q =         require('q'),
    fs =        require('fs'),
    path =      require('path'),
    mkdirp =    require('mkdirp'),
    _ =         require('lodash'),
    strftime =  require('strftime'),
    request =   require('requestretry');

/**
 * Global vars
 */
var apiHost = 'api.layervault.com',
    apiClient = new Client(),
    token,
    folderName = strftime('%Y%m%d-%H%M%S'),
    startFolder = 'out/' + folderName,
    args = processCommandLineArgs(process.argv.slice(2)),
    treeObjects = {};

/**
 * Configuration for each layer of the API
 * 	endPoint:     The Layervault endpoint path for this item type
 * 	children:     Configuration for the types of children each item has
 * 								and how to fetch their ids.
 * 	processNode:  Called when this node needs to be post processed and written
 * 								to disk.
 */
var apiConfig = {
  "organizations": {
    endPoint: "/api/v2/organizations/${ids}",
    children: [
      { type: "projects", get: function(org) { return org.links.projects; } },
      { type: "users", get: function(org) { return org.links.users; }}
    ],
    processNode: function(node, filePath){
      var newPath = filePath + '/' + node.name;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));
      return newPath;
    }
  },
  "projects": {
    endPoint: "/api/v2/projects/${ids}",
    children: [
      { type: "folders", get: function(proj) { return proj.links.folders; } },
      { type: "files", get: function(proj) { return proj.links.files; } }
    ],
    processNode: function(node, filePath){
      var newPath = filePath + '/' + node.name;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));
      return newPath;
    }
  },
  "folders": {
    endPoint: "/api/v2/folders/${ids}",
    children: [
      { type: "folders", get: function(folder) { return folder.links.folders; } },
      { type: "files", get: function(folder) { return folder.links.files; } }
    ],
    processNode: function(node, filePath){
      var newPath = filePath + '/' + node.name;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));
      return newPath;
    }
  },
  "files": {
    endPoint: "/api/v2/files/${ids}",
    children: [
      { type: "revision_clusters", get: function(file) { return file.links.revision_clusters; } },
      { type: "revisions", get: function(file) { return file.links.revisions; } }
    ],
    processNode: function(node, filePath){
      var newPath = filePath + '/' + node.slug;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));
      return newPath;
    }
  },
  "revision_clusters": {
    endPoint: "/api/v2/revision_clusters/${ids}",
    children: [
      { type: "revisions", get: function(cluster) { return cluster.links.revisions; } }
    ],
    processNode: function(node, filePath){
      // No need to create a new folder for clusters
      return filePath;
    }
  },
  "revisions": {
    endPoint: "/api/v2/revisions/${ids}",
    children: [
      { type: "previews", get: function(revision) { return revision.links.previews; } }
    ],
    processNode: function(node, filePath){
      var newPath = filePath + '/revision-' + node.revision_number;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));

      // Request the file and save it in the revision folder
      if(!args.skipFileAssets){
        requestAndSaveFile(node["download_url"], newPath);
      }

      return newPath;
    }
  },
  "previews": {
    endPoint: "/api/v2/previews/${ids}",
    children: [
      { type: "feedback_items", get: function(preview) { return preview.links.feedback_items; } }
    ],
    processNode: function(node, filePath){
      var folderName = 'preview - ' + node.page_number + (node.name ? ' - ' + node.name : '');
      var newPath = filePath + '/' + folderName;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/meta.json', JSON.stringify(node, null, 2));

      // Handle Feedback
      if(node.links.feedback_items && node.links.feedback_items.length > 0){
        var commentPath = newPath + "/comments.md";

        node.links.feedback_items.forEach(function(feedbackId, i){
          if(treeObjects["feedback_items"][feedbackId]){
            writeFeedback(treeObjects["feedback_items"][feedbackId], commentPath, i, 0);
          }
        });
      }

      // Request the preview file and save it in the folder
      if(!args.skipFileAssets){
        requestAndSaveFile(node["url"], newPath, "preview.png");
      }

      return newPath;
    }
  },
  "feedback_items": {
    endPoint: "/api/v2/feedback_items/${ids}",
    children: [
      { type: "feedback_items", get: function(feedbackItem) { return feedbackItem.links.replies; } }
    ],
    processNode: function(node, filePath){
      // Nothing special
      return filePath;
    }
  },
  "users": {
    endPoint: "/api/v2/users/${ids}",
    children: [ ],
    processNode: function(node, filePath){
      var newPath = filePath + '/users';
      var fileName = node.first_name + "-" + node.last_name;
      mkdirp.sync(newPath);
      fs.writeFileSync(newPath + '/' + fileName + '.json', JSON.stringify(node, null, 2));
      return newPath;
    }
  }
}

/*********************************
* Main app
*********************************/
authenticate(args.user, args.password, args.clientId, args.clientSecret)
  .then(function(token){

    /**
     * Start fetchin'
     * Start with the organization call and read all levels of data into memory
     * This will allow us to get away with fewer API calls and should keep us
     * under the limit.
     */
    console.log("Starting fetch");

    fetchApiItems(token, "organizations", [args.organizationId])
      .then(function(){

        // Report what was fetched
        _.keys(treeObjects).forEach(function(key){
          console.log("Fetched: " + _.keys(treeObjects[key]).length + " " + key);
        });

        postProcess();
      })
      .catch(handleError);
  })
  .catch(handleError);



/*********************************
* Item fetching functions
*********************************/

/**
 * Fetches items from the LayerVault api recursively.
 * First fetches the items by id specified, then recursively
 * iterates through returned items children and fetches them from the
 * api as well.
 *
 * @param token    The oauth2 token
 * @param itemType The item type to fetch
 * @param ids      The item ids to fetch
 * @return         A promise that resolves when all items have been retrieved
 */
function fetchApiItems(token, itemType, ids){

  var deferred = Q.defer();

  var itemTypeConfig = apiConfig[itemType];

  // If no ids were requested
  if(ids.length === 0){
    deferred.resolve();
    return deferred.promise;
  }

  // Request this level from the API
  fetchFromApi(token, itemTypeConfig.endPoint, itemType, ids)
    .then(function(items){

      // When items are returned, add them to the index
      indexTreeItems(itemType, items);

      // Now process any children
      Q.all(itemTypeConfig.children.map(function(c){
        return fetchApiItems(token, c.type, _.flatten(items.map(c.get)));
      }))
      .then(function(){
        deferred.resolve();
      })
      .catch(handleError);
    });

  return deferred.promise;
}

/**
* Fetches items from the Layervault api
* Will chunk ids into smaller groups as needed to keep the
* request size down
*
* @param token    The oauth2 token
* @param endPoint The api endpoint path
* @param itemType The type of item being requested
* @param ids      The ids of the items being requested
* @return         A promise of the Layervault objects requested
*/
function fetchFromApi(token, endPoint, itemType, ids){

  var deferred = Q.defer();

  // If we want to limit the number of requests for testing purposes
  if(args.testingLimit){
    ids = ids.slice(0, args.testingLimit);
  }

  console.log('Fetching ' + ids.length + ' from: ' + endPoint);

  var chunkPromises = _.chunk(ids, args.maxIdsPerRequest).map(function(ids){
    return _get(token, endPoint, ids);
  });

  Q.all(chunkPromises).then(function(results){

    var flattened = _.flatten(results.map(function(r){
      return r[itemType];
    }));

    deferred.resolve(flattened);
  })
  .catch(handleError);

  return deferred.promise;
}

/**
* Helper function to access api methods. This shouldn't be used directly
* All api access should go through fetchFromApi
* @param  token     The oauth2 token
* @param  endpoint  The API method
* @param  ids       The item ids
* @return           A promise of the API response as an object
*/
function _get(token, endpoint, ids){

  var deferred = Q.defer();

  var headers = {
    'Authorization': 'Bearer ' + token.token['access_token']
  };

  apiClient.get('https://' + apiHost + endpoint,
  {
    headers: headers,
    path: {'ids': ids}
  }, function(data, response){

    if(response.statusCode != 200){
      console.log("Error: " + response.statusCode + " on endpoint: " + endpoint);
      deferred.reject();
    }

    if(!data){
      console.log("Error: Empty data response on endpoint: " + endpoint);
      deferred.reject();
    }

    var obj = JSON.parse(data);

    deferred.resolve(obj);
  });

  return deferred.promise;
}

/**
 * Pushes items on to the treeObjects collection
 * @param itemType The type
 * @param items    The items to push
 */
function indexTreeItems(itemType, items){
  treeObjects[itemType] = treeObjects[itemType] || {};
  items.forEach(function(i){
    treeObjects[itemType][i.id] = i;
  });
}



/*********************************
* Post Processing functions
*********************************/

/**
* Starts post processing of nodes. Should be called after all
* node levels are loaded from the API
*/
function postProcess(){
  console.log('Starting post process');

  mkdirp.sync('out');
  mkdirp.sync(startFolder);

  // Depth first tree traversal
  _.values(treeObjects['organizations']).forEach(function(node){
    processNode('organizations', node, startFolder);
  });
}

/**
* Recursive method for processing each node in the tree
* Folders are created on disk and the contents of the node are written to the folder
* The node tree is traversed depth first
*
* @param type      The current object type
* @param node      The node to process
* @param startPath The current file path on disk for writing data
*/
function processNode(type, node, startPath){

  var config = apiConfig[type];

  var childFolder = config.processNode(node, startPath);

  // Loop over types of children for this node
  config.children.forEach(function(childConfig){
    // Loop over child ids for this type
    childConfig.get(node).forEach(function(childId){
      var child = treeObjects[childConfig.type][childId];

      if(!child){
        console.log('Error - no object in ' + childConfig.type + ' for ID: ' + childId);
        return;
      }

      processNode(childConfig.type, child, childFolder);
    });
  });
}

/**
* Writes a feedback line to the file (recursive)
* @param feedbackNode The feedback item
* @param filePath     The file path
* @param index        The feedback item index
* @param depth        The feedback depth
*/
function writeFeedback(feedbackNode, filePath, index, depth){

  var user = treeObjects['users'][feedbackNode.links.user];

  var comment =
  Array(depth + 1).join('  ') + (index + 1) + '. ' +
  '**' + user.first_name + " " + user.last_name + ' (' + user.email + ')**: ' +
  '*' + feedbackNode.created_at + '* - ' +
  feedbackNode.message + '\n';

  fs.appendFileSync(filePath, comment);

  feedbackNode.links.replies.forEach(function(r, i){
    if(treeObjects["feedback_items"][r]){
      writeFeedback(treeObjects["feedback_items"][r], filePath, i, depth + 1);
    }
  });
}

/*********************************
* File asset fetching functions
*********************************/

var requestQueue = [],
    currentRequests = 0;

/**
 * Push a new file asset request on to the queue
 * @param url          The file asset url
 * @param saveLocation The location on disk to save the file
 * @param fileName     (optional) The file name. If this isn't provided
 *                     the filename will attempt to be pulled from the
 *                     content-disposition header
 */
function requestAndSaveFile(url, saveLocation, fileName){

  requestQueue.push({
    url: url,
    path: saveLocation,
    fileName: fileName
  });

  processFileRequestQueue();
}

/**
 * Process the file request queue. This function is responsible
 * for throttling the file asset requests to the maxConcurrentRequests
 */
function processFileRequestQueue(){

  if(currentRequests >= args.maxConcurrentRequests || requestQueue.length === 0){
    return;
  }

  // Kick off a new request
  currentRequests++;

  var asset = requestQueue.pop();

  var requestOptions = {
    url: asset.url,
    headers: {
      'Authorization': 'Bearer ' + token.token['access_token']
    },
    maxAttempts: 5,
    retryDelay: 1000
  };

  try{
    console.log("Requesting File: " + asset.url);
    var r = request(requestOptions);
    r.on('response',  function (res) {

      currentRequests--;
      processFileRequestQueue();

      if(res.headers['status'] === '404 Not Found'){
        console.log("Not Found: " + asset.url);
        return;
      }

      console.log("File received: " + asset.url);

      var fileName = asset.fileName || getFileNameFromHeader(res);
      res.pipe(fs.createWriteStream(asset.path + '/' + fileName));

    });
  }
  catch(err){
    currentRequests--;
    processFileRequestQueue();
    console.log("Error fetching preview", err);
  }

  processFileRequestQueue();
}

/*********************************
* Misc. functions
*********************************/

/**
 * Authenticate the userf
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
 * @return The file name
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

/**
 * Process command line arguments
 * @param commandLineArgs An array of arguments passed in on the command line
 * @return The configurable parameters object
 */
function processCommandLineArgs(commandLineArgs){

  if(commandLineArgs.length < 4){
    console.log('You forgot to include your LayerVault Username, password, Client ID and Secret');
    process.exit(1);
  }

  if(commandLineArgs.length < 5){
    console.log('You forgot to include your Organization ID');
    process.exit(1);
  }

  // set args
  var argsOut = {
    user: commandLineArgs[0],
    password: commandLineArgs[1],
    clientId: commandLineArgs[2],
    clientSecret: commandLineArgs[3],
    organizationId: commandLineArgs[4],

    // defaults
    maxIdsPerRequest: 400,
    testingLimit: 0,
    maxConcurrentRequests: 10,
    skipFileAssets: false
  }

  var optionalArgs = commandLineArgs.slice(5);

  while(optionalArgs.length > 0){
    switch(optionalArgs[0]){
      case '--maxIdsPerRequest':
        argsOut.maxIdsPerRequest = +optionalArgs[1];
        optionalArgs = optionalArgs.slice(2);
        break;
      case '--testingLimit':
        argsOut.testingLimit = +optionalArgs[1];
        optionalArgs = optionalArgs.slice(2);
        break;
      case '--maxConcurrentRequests':
        argsOut.maxConcurrentRequests = +optionalArgs[1];
        optionalArgs = optionalArgs.slice(2);
        break;
      case '--skipFileAssets':
        argsOut.skipFileAssets = true;
        optionalArgs = optionalArgs.slice(1);
        break;
      default:
        optionalArgs = optionalArgs.slice(1);
        break;
    }
  }

  return argsOut;
}
