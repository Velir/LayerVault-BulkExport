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
    request = require('request');

if(args.length < 4){
  console.log('You forgot to include your LayerVault Username, password, Client ID and Secret');
  process.exit(1);
}

var folderName = strftime('%Y%m%d-%H%M%S'),
    outputFolder = './out/' + folderName;

mkdirp(outputFolder);

var oauth2 = require('simple-oauth2')({
  clientID: args[2],
  clientSecret: args[3],
  site: 'https://' + apiHost,
  tokenPath: '/oauth/token'
});

// Get the access token object for the client
oauth2.password.getToken({
  username: args[0],
  password: args[1]
}, success);

// When the access token is returned, we're off
function success(error, result) {
  if (error) {
    console.log('Access Token Error', error.message);
    process.exit(1);
  }

  token = oauth2.accessToken.create(result);

  // ***
  // Helper function to access api methods
  // ***
  function get(method, path, parameters){

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

  // Start fetchin'

  get('me')
    .then(function(meData){
      var organizations = meData.users[0].links.organizations;
      return get('organizations/${ids}', {"ids": organizations.join(',')});
    })
    .then(function(orgData){

      return orgData.organizations.map(function(organization){

        var orgFolder = outputFolder + '/' + organization.name;
        mkdirp(orgFolder);
        fs.writeFile(orgFolder + '/meta.json', JSON.stringify(organization, null, 2));

        var projects = organization.links.projects;

        return get('projects/${ids}', {"ids": projects.join(',')})
          .then(function(projData){

            return projData.projects.map(function(project){

              var projFolder = orgFolder + '/' + project.name;
              mkdirp(projFolder);
              fs.writeFile(projFolder + '/meta.json', JSON.stringify(project, null, 2));

              var folders = project.links.folders;

              return get('folders/${ids}', {"ids": folders.join(',')})
                .then(function(folderData){
                  return folderData.folders.map(function(folder){

                    var folderFolder = projFolder + '/' + folder.name;
                    mkdirp(folderFolder);
                    fs.writeFile(folderFolder + '/meta.json', JSON.stringify(folder, null, 2));

                    var files = folder.links.files;

                    return get('files/${ids}', {"ids": files.join(',')})
                      .then(function(fileData){
                        return fileData.files.map(function(file){

                          var fileFolder = folderFolder + '/' + file.slug;
                          mkdirp(fileFolder);
                          fs.writeFile(fileFolder + '/meta.json', JSON.stringify(file, null, 2));

                          var revisionClusters = file.links["revision_clusters"];

                          return get('revision_clusters/${ids}', {"ids": revisionClusters.join(',')})
                            .then(function(rcData){

                              return rcData["revision_clusters"].map(function(revisionCluster){

                                var rcFolder = fileFolder + '/cluster-' + revisionCluster.cluster_number;
                                mkdirp(rcFolder);
                                fs.writeFile(rcFolder + '/meta.json', JSON.stringify(revisionCluster, null, 2));

                                var revisions = revisionCluster.links.revisions;

                                return get('revisions/${ids}', {"ids": revisions.join(',')})
                                  .then(function(revisionData){

                                    return revisionData.revisions.map(function(revision){

                                      var revisionFolder = rcFolder + '/revision-' + revision.revision_number;
                                      mkdirp(revisionFolder);
                                      fs.writeFile(revisionFolder + '/meta.json', JSON.stringify(revision, null, 2));

                                      // *** download the file here!
                                      var r = request(revision["download_url"]);
                                      r.on('response',  function (res) {
                                        if(res.headers['status'] === '404 Not Found'){
                                          console.log("Not Found: " + revision["download_url"]);
                                          return;
                                        }
                                        var fileName = getFileNameFromHeader(res);
                                        res.pipe(fs.createWriteStream(revisionFolder + '/' + fileName));
                                      });

                                      // var previews = revision.links.previews;
                                      //
                                      // return get('previews/${ids}', {"ids": previews.join(',')})
                                      // .then(function(previewData){
                                      //
                                      //   return previewData.previews.map(function(preview){
                                      //
                                      //     var previewFolder = revisionFolder + '/' + preview.name;
                                      //     mkdirp(previewFolder);
                                      //     fs.writeFile(previewFolder + '/meta.json', JSON.stringify(preview, null, 2));
                                      //
                                      //     var feedbackItems = revision.links["feedback_items"];
                                      //
                                      //     var feedbackCompiled = "";
                                      //
                                      //     var feedbackPromises = get('feedback_items/${ids}', {"ids": feedbackItems.join(',')})
                                      //     .then(function(feedbackData){
                                      //
                                      //
                                      //
                                      //
                                      //     });
                                      //
                                      //     return feedbackPromises;
                                      //   });
                                      //
                                      // });
                                    });

                                  });
                              });
                            });
                       });
                    });
                  });
              });
            });
          });
      });
    })
    .catch(function(error){
      console.log(error);
    });

}

function getFileNameFromHeader(response){
  var regexp = /.*?\'\'(.*)/i;
  return regexp.exec( response.headers['content-disposition'] )[1];
}
