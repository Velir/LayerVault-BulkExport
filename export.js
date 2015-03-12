#!/usr/bin/env node

var args = process.argv.slice(2);
var token;

if(args.length < 4){
  console.log('You forgot to include your LayerVault Username, password, Client ID and Secret');
  process.exit(1);
}

var oauth2 = require('simple-oauth2')({
  clientID: args[2],
  clientSecret: args[3],
  site: 'https://api.layervault.com',
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

  console.log(token);
}
