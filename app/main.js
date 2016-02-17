'use strict';

const electron = require('electron');
const lunr = require('lunr');
const path = require('path');
var fs = require('fs');
const ipcMain = require('electron').ipcMain;
const clipboard = require('electron').clipboard;
const appName = 'myNotebook';
var lunr_index;

// Module to control application life.
const app = electron.app;

// Set the paths for the app
const root_path = path.join(app.getPath('home'),"myNotebook");
const images_path = path.join(app.getPath('home'),"myNotebook", "images");
const data_path = path.join(app.getPath('home'),"myNotebook", "data");

// Module to create native browser window.
const BrowserWindow = electron.BrowserWindow;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

// setup the db
var nedb = require('nedb');
var db = new nedb();
db = {};
db.posts = new nedb({ filename: path.join(data_path, 'posts.db'), autoload: true });

// setup lunr indexing
lunr_index = lunr(function () {
    this.field('post_body', { boost: 10 });
});

function createWindow() {
    // Create the browser window.
    var atomScreen = require('screen');
    var size = atomScreen.getPrimaryDisplay().workAreaSize;
    
    // create the window
    mainWindow = new BrowserWindow({ 
        width: size.width - 200, 
        height: size.height - 100,
        icon: path.join(__dirname, 'myNotebook.png')
    });

    // and load the index.html of the app.
    mainWindow.loadURL('file://' + __dirname + '/index.html');
    
    // set the app name to the title bar
    mainWindow.setTitle(appName);
  
    // remove the default menu
    mainWindow.setMenu(null);

    // Open the DevTools.
    //mainWindow.webContents.openDevTools();
    
    // create an app folder in the users home directory if it doesnt exist
    if (!fs.existsSync(root_path)){
        fs.mkdirSync(root_path);
    }
    
    // create an backups folder in the users home directory if it doesnt exist
    if (!fs.existsSync(path.join(root_path, 'backups'))){
        fs.mkdirSync(path.join(root_path, 'backups'));
    }
    
    // create the folder which holds any pasted images if it doesn't exist
    if (!fs.existsSync(images_path)){
        fs.mkdirSync(images_path);
    }

    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
    
    // get all posts on startup
    db.posts.find({}, function (err, post_list) {
        // add to lunr index
        post_list.forEach(function(posts) {
            var doc = {
                "post_body": posts.post_body,
                "id": posts._id
            };        
            lunr_index.add(doc);
        });
    });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow();
    }
});

// shows a confirm dialog and deletes a post
ipcMain.on('deletePost', function (event, args) {
    var dialog = require('electron').dialog;
    var buttons = ['OK', 'Cancel'];
    dialog.showMessageBox({ type: 'warning', buttons: buttons, message: 'Are you sure you want to delete this post?' }, function (buttonIndex) {;
        if(buttons[buttonIndex] == "OK"){
            db.posts.remove({ _id: args.doc_id }, {}, function (err, numRemoved) {
                var result = true;
                if(err){
                    result = false;
                }
                if(numRemoved == 0){
                    result = false;
                }
                event.sender.send('postDeleted', result);
            });
        }
    });
});

// gets image from clipboard and writes to the /images directory
ipcMain.on('writeImage', function (event, img) {
    if(clipboard.readText() == ""){
        var filename = "image-" + Date.now() + ".png";
        fs.writeFile(path.join(images_path, filename), clipboard.readImage().toPng(), function (err) {
            if (err)
                throw err;
            event.sender.send('gotImage', path.join(images_path, filename));
        });
    }else{
        event.sender.send('gotImage', '');
    }
});

// cleans up any unused images
ipcMain.on('cleanUpImages', function (event, args) {
    var walk    = require('walk');
    var walkPath = images_path;
    var walker  = walk.walk(walkPath, { followLinks: false });

    walker.on('file', function(root, stat, next) {
        var file_name = path.resolve(root, stat.name);
        
        // find posts with the file in question
        db.posts.find({"post_body": new RegExp(stat.name)}).exec(function (err, posts) {
            // if the images doesn't exists in any posts then we remove it
            if(posts.length == 0){
                fs.unlinkSync(file_name);
            }
            next();
        });
    });

    walker.on('end', function() {
        event.sender.send('cleanUpImagesComplete');
    });
});

// backs up the /data and /images folders
ipcMain.on('backupData', function (event, args) {
    var easy_zip = require('easy-zip').EasyZip;
    
    var zip = new easy_zip();
    zip.zipFolder(data_path,function(){
        zip.zipFolder(images_path,function(){
	       zip.writeToFile(path.join(root_path, 'backups','dataBackup.zip'));
           event.sender.send('backupDataComplete', path.join(root_path, 'backups', 'dataBackup.zip'));
        });
    });
});

// query posts
ipcMain.on('queryPosts', function (event, args) {
    // we strip the ID's from the lunr index search
	var lunr_id_array = new Array();
	lunr_index.search(args.search_term).forEach(function(id) {
		lunr_id_array.push(id.ref);
	});
    
    db.posts.find({ _id: { $in: lunr_id_array}}).sort({post_date: -1}).exec(function (err, posts) {
        event.sender.send('gotSearch', posts);
    });
});

// updates the lunr index
function update_lunr(post){
    // create lunr doc
    var lunr_doc = { 
        post_body: post.post_body,
        id: post._id
    };
    
    // update the index
    lunr_index.update(lunr_doc, false);
}

// get X amount of posts. Can also skip for pagination
ipcMain.on('getPosts', function (event, args) {
    var start = args.start ? args.start : 0;
    var limit = args.limit ? args.limit : 5;
    db.posts.find({}).sort({ post_date: -1 }).skip(start).limit(limit).exec(function (err, posts) {
        event.sender.send(args.caller, posts);
    });
});

// get last 10 docs
ipcMain.on('getRecents', function (event, arg) {
    db.posts.find({}).sort({ post_date: -1 }).limit(10).exec(function (err, posts) {
        event.sender.send('gotRecents', posts);
    });
});

// inserts a doc
ipcMain.on('insertQuery', function (event, doc) {
    db.posts.insert(doc, function (err, newDoc) {
        var data = {}; 
        data.result = true;
        if(err){
            data.result = false;
        }
        
        // set the ID to return
        data._id = newDoc._id;
        
        // update the lunr index
        update_lunr(newDoc);
        
        // send the result
        event.sender.send('docInserted', data);
    });
});

// updates a document
ipcMain.on('updateQuery', function (event, doc) {    
    db.posts.update({ _id: doc._id }, doc , {}, function (err, numReplaced) {
        // default to true
        var result = true;
        
        // set result to false if an error occurs
        if(err){
            result = false;
        }
        
        // set result to false if no docs are updated
        if(numReplaced == 0){
            result = false;
        }
        
        // update the lunr index
        update_lunr(doc);
        
        // send the updated doc
        event.sender.send('docUpdated', result);
    });
});

// gets post by ID
ipcMain.on('getOne', function (event, args) {
    db.posts.findOne({ _id: args.doc_id }, function (err, doc) {
        event.sender.send(args.caller, doc);
    });
});

// gets the total post count
ipcMain.on('getPostCount', function (event, args) {
    db.posts.count({}, function (err, doc) {
        event.returnValue = doc;
    });
});