'use strict';
var VERSION  = '0.3.2';
var zmq      = require('zmq')
  , sock     = zmq.socket('sub')
  , zlib     = require('zlib')
  , sprintf  = require("sprintf-js").sprintf
  , http     = require('http')
  , https    = require('https')
  , url      = require('url')
  , stream   = require('stream')
  , winston  = require('winston')
  , lineFilt = require('./lineedit.js')
;

winston.configure({
    transports: [
        new (winston.transports.Console)({level:'info', colorize: true}),
        new (winston.transports.File)({
            Filename: 'eddn.log',
            dirname: __dirname,
            level: 'verbose',
            timestamp: true,
            json: false,
            maxsize: 10000000,
            maxFiles: 3
        })
    ]
});
var LOG = winston.log;

LOG('info', 'Starting eddn listener/web server v.' + VERSION);
// these next variables can be used to tune item price checks
const TOP_LIMIT = 1500; //% how many percents sell/buy price can be higher than mean price
const BOT_LIMIT = 1500; //% how many percents can sell/buy price be lower than mean price

// other program defining constant
// define the port where you want this server to run, can be also 80 if you don't have
// any other (web)service running in that port. E.g. localhost:1185/elite or if port 80,
// then just localhost/elite to access your server
const PORT = 1185;

//how long same commodities file is used before new one is downloaded
//commodities file is used to obtain info about commodity ids.
const COMSEXPIRE = 1000*60*60*24*7; //in milliseconds
const COMFILE = 'commodities.json';
const STATIONFILE = 'stations.json';
const SYSTEMFILE = 'systems_populated.json';
const comUrl = 'https://eddb.io/archive/v5/commodities.json';
const stationUrl = 'https://eddb.io/archive/v5/stations.json';
const systemUrl = 'https://eddb.io/archive/v5/systems_populated.json';

var jsons = new Array(); //this variable will store all the received eddn jsons
// schema files will be buffered after first download, schema1 is old address
// and schema3 is new address, schema1 is probably obsolete.
var schema1 = null;
var schema3 = null;

// counter for how many times we have sent 3hdata to those who have asked
var reqCount = 0;

var jsonStorageFile = __dirname + '/jsonStorage.txt';

var commodities = {time : '', data : ''};
var stationMap={};
var systemsMap = {};

var comfileexists = false;

if (require('fs').existsSync(COMFILE)) {
    var fInfo = require('fs').statSync(COMFILE);
    commodities.time = fInfo.birthtime;
}

function handleStationJson(strJson) {
    let stations = JSON.parse(strJson);
    for(var i = 0; i < stations.length; i++){
        let system = systemsMap[stations[i].system_id].name;
        stationMap[stations[i].name+'/' + system] = stations[i];
    }
    LOG('info', 'Station data parsed to json object');
}

function handleComJson(strJson) {
    commodities.time = new Date();
    commodities.data = JSON.parse(strJson);
    commodities.data = convertCommodities(commodities.data);
}

function handleSystems(strJson) {
    let systems = JSON.parse(strJson);
    for(let i = 0; i < systems.length; i++)
        systemsMap[systems[i].id] = systems[i];
    LOG('info', 'Systems data has been loaded into memory');
}

// write eddn json to storage file
// This is closed during purge operation and thus needs to be reopened
// after purge is done.
var okToWrite = false; //flag for writing into storageJson
var jsonWriter = require('fs').createWriteStream(jsonStorageFile, {'flags':'a'});

jsonWriter.on('error', (error) => {
    LOG('error', 'Failed to writer json to storage file: ' + error);
});
jsonWriter.on('close', () => LOG('debug', 'Initial writer handle closed') );

// Filter for the lineFilter method
// input: timeStamp in milliseconds, line has to be newer than this or deleted
class Filter {
    constructor(timeStamp) {
        this.timeStamp = timeStamp;
    }
    
    filter(line) {
        var array = line.split(':');
        if(array[0] > this.timeStamp){
            return true;
        }
        return false;
    }
};

class DuplicateFilter {
    constructor(stationNames) {
        this.stationNames = stationNames;
    }

    // if stationName can be found from line, return false, thus
    // leaving the line out from new file
    filter(line) {
        line = line.toString();
        for(let i = 0; i < this.stationNames.length; i++) {
            let system = this.stationNames[i].slice(
                this.stationNames[i].indexOf('/')+1);
            let station = this.stationNames[i].slice(
                0, this.stationNames[i].indexOf('/'));

            if(line.match(new RegExp(station)) &&
               line.match(new RegExp(system))) {
                return false;
            }
        }
        return true;
    }
};

// lets make stuff a bit more synchronized, we need to have comjson and
// stations.json in memory, before we can parse eddn json traffic
// (or mainly load that big json storage file into memory)
// Lets use promises for that

var systemPromise = new Promise((ok, reject) => {
    downloadFile(systemUrl, SYSTEMFILE, handleSystems, () => {
        ok();
    });
});

systemPromise.then(()=> {
    var stationPromise = new Promise((ok, reject) => {
        // this can take some time compared to other files.
        downloadFile(stationUrl, STATIONFILE, handleStationJson, () => {
            ok();
        });
        
    });
    
    var purgePromise = new Promise((ok, reject) => {
        jsonFilePurge(jsonStorageFile, () => {
            ok();
        });
    });
    
    var comJsonPromise = new Promise((ok, reject) => {
        downloadFile(comUrl, COMFILE, handleComJson, () => {
            ok();
        });
    });

    return Promise.all([stationPromise, purgePromise, comJsonPromise]);
}).catch(err => {
    LOG('error', 'Failed to download or use systems.json: ' + err);
    process_exit(1);
}).then(() =>{
    loadJsonStorage(jsonStorageFile, commodities.data, () => {
        okToWrite = true;
        createWebServer();
    });
});

// try updating commodity.json at COMSEXPIRE interval
// to force update, just delete commodity.json before running eddn.js
const intervalObj = setInterval(updateCommodities, COMSEXPIRE);

// Delete old lines from json storage file, while the method is run, store the
// starting timestamp and when the purgin is complete, save the files from 3h
// buffer to the file, starting from the timestamp.
var purgeStart = null;
var purgeComplete = false;
function jsonFilePurge(jsonFile, cb){
    okToWrite = false;
    LOG('debug', 'Purging old data from: ' + jsonFile);
    var fs = require('fs');
    purgeStart = new Date().getTime();
    
    var filt = new Filter(purgeStart - 1000*60*60*24); //delete older than 24h

    lineFilt.lineFilter(jsonFile, filt.filter.bind(filt), (err)=> {
        if(err)
            LOG('error', 'Linefilter failed: ' + err);
        else 
            LOG('debug', jsonFile + ' purged of old data (>24h)');
        purgeComplete = true;
        LOG('debug', 'opening file...');
        jsonWriter = fs.createWriteStream(jsonFile, {'flags':'a'});
        jsonWriter.on('open', () => cb());
        jsonWriter.on('error', err => {
            LOG('error', 'Linefilt failed to write due to: ' + err);
        });
        jsonWriter.on('close', () => LOG('debug', 'Post purge jsonfile close'));
    });
}

function remDupFromStorage(jsonFile, stationNames, cb) {
    okToWrite = false;
    if(stationNames.length === 0){
        LOG('warning', 'Empty stations for purge!');
        cb();
        return;
    }
    LOG('debug', 'Purging duplicate for: ' + stationNames +
        ' from: ' + jsonFile);
    var fs = require('fs');

    purgeStart = new Date().getTime();

    var filt = new DuplicateFilter(stationNames); 

    lineFilt.lineFilter(jsonFile, filt.filter.bind(filt), ()=> {
        LOG('debug', jsonFile + ' duplicates removed');
        purgeComplete = true;
    });
}

// remove obsolete json strings from file at 10 minute intervals
const jsonPurgeInterval = setInterval(() =>
                                      jsonFilePurge(jsonStorageFile,
                                                    () => {}),
                                      1000*60*10);
// Create the actual web server which will serve web pages and data
function createWebServer() {
    LOG('info', 'Creating web server');
    var server = http.createServer(function (req, res) {
        if (req.method.toLowerCase() == 'get') {
            var u = url.parse(req.url).pathname;
            if(u === "/elite"|| u === "/elite/") {
                displayPage(res);
                return;
            }
            else if(u==="/elite/3hdata") {
                downloadPage(res, jsons, 'json');
                return;
            }
            else if(u==="/elite/3hdataCSV") {
                downloadPage(res, jsons, 'csv');
            }
            else if(u==="/elite/24hdataCSV") {
                upload24h(res, jsonStorageFile, commodities.data);
            }
            else {
                res.writeHead(404, {'Content-type':'text/html'});
                res.write('<h1>404 Page not found</h1>');
                res.end();
                return;
            }
        } else if (req.method.toLowerCase() == 'post') {
            return;
        }
    });

    sock.connect('tcp://eddn.edcd.io:9500');
    sock.subscribe('');
    LOG('info', 'waiting for updates...');
    sock.on('message', function(message) {
        zlib.inflate(message, function(err, chunk) {
            var payload   = JSON.parse(chunk.toString('utf8'))
            , schemaRef = payload && payload.$schemaRef
            , header    = payload && payload.header
            , data      = payload && payload.message
            ;
            
            if (schemaRef === 'http://schemas.elite-markets.net/eddn/commodity/1') {
                if(schema1 === null)
                    downloadSchema(schemaRef, payload, header, data);
                else
                    useSchema(payload, schema1, header, data, commodities.data);
                
            }
            else if(schemaRef === 'https://eddn.edcd.io/schemas/commodity/3') {
                if(schema3 === null)
                    downloadSchema(schemaRef, payload, header, data );
                else
                    useSchema(payload, schema3, header, data, commodities.data);
            }
            else {
                LOG('silly', 'unsupported schema in json "%s"', schemaRef); 
                return;
            }
        });
    });
    server.listen(PORT).on('error', error => {
        LOG('error', 'Port ' + PORT +' is already in use, maybe eddn is running?');
        LOG('error', error);
        process.exit(1);
    });
    LOG('info', "server listening on " + PORT);
}
// This will download schema file from eddn.io website, then the schema
// will be used to validate all downloaded data.
// The schema file is a bit lacking, so it might be, that this stage
// will be dropped in the future since the data needs to be checked manually
// anyway.
function downloadSchema(schemaUrl, rawJson, header, data) {
    var schema='';
    const req = https.get(schemaUrl, function(response) {
        if(response.statusCode === 200) {
            response.on('data', function(chunk) {
                schema += chunk;
            });
            response.on('end', function() {
                schema = JSON.parse(schema);
                if(schemaUrl ===
                   'https://eddn.edcd.io/schemas/commodity/3')
                    schema3=schema;
                else
                    schema1=schema;
                useSchema(rawJson, schema, header, data, commodities.data);
            });
            response.on('error', function() {
                LOG('error', "Failed to download schema from " + schemaUrl);
            });
        }
        else {
            LOG('error', 'Schema url returned bad response ' +
                response.statusCode);
        }
    });
}

// Download commodities.json from eddb.io, contains unique commodity id for all items.
// Save the file to drive for later use. If the file is older than a week, redownload
// to see if anything has changed.
function downloadFile(dlUrl, storageFile, dlDataHandler, cb) {
    var fs = require('fs');
    var schema='';
    
    if (fs.existsSync(storageFile)) {
        var fInfo = fs.statSync(storageFile);
        var fileDate = fInfo.birthtime;
        var now = new Date();
        LOG('info', storageFile + ' age: ' + fileDate);
        if(now - fileDate < COMSEXPIRE) {//time diff is in milliseconds
            LOG('info', 'Using existing ' + storageFile);
            fs.readFile(storageFile, (err, data) => {
                if(err) {
                    LOG('error', 'Failed to open ' +storageFile + 'due to ' + err);
                    fs.unlink(storageFile, (err) => downloadFile(
                        dlUrl, storageFile, dlDataHandler,  () => {
                            cb();
                        }));
                }
                if(data === 'undefined')
                {
                    LOG('warning', 'Commodities data length = 0, downloading new');
                    fs.unlink(storageFile, (err) => downloadFile(
                        dlUrl, storageFile, dlDataHandler, () => {cb();}));
                }
                dlDataHandler(data);
                cb();
            });
        }
        else {
            // existing file is too old
            fs.unlink(storageFile, (err) => {
                downloadFile(dlUrl, storageFile, dlDataHandler, () =>{
                    cb();
                });
            });            
        }
    }
    else {
        // file did not exists, thus need to download it
        LOG('info', storageFile + ' did not exist, downloading it');
        var dlData='';
        const req = https.get(dlUrl, function(response) {
            if(response.statusCode === 200) {
                response.on('data', function(chunk) {
                    dlData += chunk;
                });
                response.on('end', function() {
                    commodities.time = new Date();
                    fs.writeFile(storageFile, dlData, err => {
                        if(err)
                            LOG('error', 'Failed to write ' + storageFile +
                                ' to drive');
                        else
                            LOG('info', 'Saved ' + storageFile);
                    });
                    dlDataHandler(dlData);
                    cb();
                });
                response.on('error', function() {
                    LOG('error', 'Failed to download ' + storageFile +
                        ' from ' + dlUrl);
                    cb();
                });
            }
            else{
                LOG('error', storageFile + ' url returned bad response ' +
                    response.statusCode);
                cb();
            }
        });
    }
}

// This will check if commodities.json has expired and will delete the old
// file and then calls downloadFile to update the file to more current state
function updateCommodities() {
    var now = new Date();
    if(now - commodities.time > COMSEXPIRE)
    {
        LOG('info', COMFILE + ' has expired, downloading new one');
        var fs = require('fs');
        fs.unlink(COMFILE, (err) => {
            commodities.time = '';
            downloadFile(comUrl, COMFILE);
        });
    }
}
// this method will convert commodities.json commodities names to names
// that eddn network provides, .e.g. Narcotics become BasicNarcotics etc...
function convertCommodities(comJson) {
    // todo: get rid of these hard coded conversions and use
    // some automatic method.
    for(var j = 0; j < comJson.length; j++){
        comJson[j].name = comJson[j].name.replace(/\s|-/g,'');
        comJson[j].name = comJson[j].name.replace(/LandEnrichmentSystems/,'TerrainEnrichmentSystems');
        comJson[j].name = comJson[j].name.replace(/HardwareDiagnosticSensor/,'DiagnosticSensor');
        comJson[j].name = comJson[j].name.replace(/H\.E\.Suits/,'HazardousEnvironmentSuits');
        comJson[j].name = comJson[j].name.replace(/LowTemperatureDiamonds/,'LowTemperatureDiamond');
        comJson[j].name = comJson[j].name.replace(/MethanolMonohydrate$/,'MethanolMonohydrateCrystals');
        comJson[j].name = comJson[j].name.replace(/AgriMedicines/,'AgriculturalMedicines');
        comJson[j].name = comJson[j].name.replace(/EnergyGridAssembly/,'PowerGridAssembly');
        comJson[j].name = comJson[j].name.replace(/MicrobialFurnaces/,'HeliostaticFurnaces');
        comJson[j].name = comJson[j].name.replace(/^Narcotics/,'BasicNarcotics');
        comJson[j].name = comJson[j].name.replace(/SkimmerComponents/,'SkimerComponents');
        comJson[j].name = comJson[j].name.replace(/HardwareDiagnosticSensor/,'DiagnosticSensor');
        comJson[j].name = comJson[j].name.replace(/MarineEquipment/,'MarineSupplies');
        comJson[j].name = comJson[j].name.replace(/AtmosphericProcessors/,'AtmosphericExtractors');
        comJson[j].name = comJson[j].name.replace(/SurveyDataCache/,'explorationdatacash');
        comJson[j].name = comJson[j].name.replace(/^MicroWeaveCoolingHoses$/,'CoolingHoses');
        comJson[j].name = comJson[j].name.replace(/^PowerTransferBus$/,'PowerTransferConduits');
    }
    return comJson;
}

// uses the downloaded schema and commodities.json to parse eddn jsons.
function useSchema(rawJson, schema, header, data, comJson) {
    var fs = require('fs');
    // validate data, i.e. so that all fields are correct
    if(!validate(rawJson, schema))
        return;

    var time = new Date(Date.parse(header.gatewayTimestamp));
    // first check if data already exists in jsons array, delete old if it does
    jsons = jsons.filter(item => {
        return data.stationName !== item[1].stationName && data.systemName !== item[1].systemName;
    });
    
    addJsonToJsons(data, time, comJson, () => {
        LOG('debug', "jsons size %s", jsons.length); 
    
        // next remove all items older than 3 hours from the array
        var count = 0;
        while(jsons[count][0] < Date.now() - 3*60*60*1000)
            count++;
        jsons.splice(0, count);
        LOG('debug', 'removed old items from memory: ' + count);
        
        if(okToWrite) {
            let toRemove = data.stationName+'/'+data.systemName;
            remDupFromStorage(jsonStorageFile, [toRemove], () => {
                LOG('debug', 'Writing json to storage file');
                LOG('debug', 'opening file...');
                jsonWriter = fs.createWriteStream(jsonStorageFile, {'flags':'a'});
                jsonWriter.on('error', err => {
                    LOG('error', 'Failed to write ' + jsonFile +
                        ' due to ' + err);
                    return;
                });
                jsonWriter.on('close', () => LOG('silly', 'remDupClose writer'));
                jsonWriter.write(time.getTime() + ':' + JSON.stringify(rawJson)
                                 + '\n', () => jsonWriter.end());
            });
        }
        else if(purgeComplete) {
            let now = new Date();
            LOG('debug', 'Purge done, emptying buffer to json storage.' +
                ' Purge took: ' + (now - purgeStart)/1000 + 's');
            let i = jsons.length - 1;

            let toRemove = new Array();
            while(jsons[i][0] > Date.parse(purgeStart) && i > 0) {
                toRemove.push(jsons[i][1].stationName + '/' +
                              jsons[i][1].systemName);
                i--;
            }
            let tmp = '';
            remDupFromStorage(jsonStorageFile, toRemove, () => {
                while(i < jsons.length) {
                    tmp += jsons[i][0] + ':' + JSON.stringify(jsons[i][1]) + '\n';
                     i++;
                }
                LOG('debug', 'opening file...');
                jsonWriter = fs.createWriteStream(jsonStorageFile, {'flags':'a'});
                jsonWriter.on('error', err => {
                    LOG('error', 'Failed to write ' + jsonFile +
                        ' due to ' + err);
                    return;
                });
                jsonWriter.on('close', () => LOG('silly', 'remDupClose writer'));
                jsonWriter.write(tmp, () => {
                    purgeComplete = false; // we are ready for next purge round
                    purgeStart = null;
                    okToWrite = true;
                    jsonWriter.end();
                });
            });
        }    
    });
}
// This will create the actual download page 3hdata.
// When user clicks the 3hdata link or uses some other way
// to download the 3hdata, then this method is executed.
// Input:
// res       = result to be streamed back to client
// dataArray = {timestamp, rawJson, csvData}
// dataType  = 'json' or 'csv', tells this method which format the user wants
function downloadPage(res, dataArray, dataType) {
    if(dataArray.length == 0) {
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end('No eddn data available');
        return;
    }
    var ss = new stream.Readable();
    // https://stackoverflow.com/questions/34687387/how-can-i-stream-a-json-array-from-nodejs-to-postgres
    res.writeHead(200, {'Content-Type': 'application/force-download',
        'Content-disposition':'attachment; filename=3hdata.' + dataType + '.gz'});

    // Create pipe that will stream and gzip data to client
    // i.e. create data "[{json1{json2}...{jsonN}] or send the csv data.
    // client then has to unzip the received file.
    ss.pipe(zlib.createGzip())
        .on('close',() =>LOG('verbose', 'zip done'))
        .pipe(res)
        .on('finish', () => {LOG('verbose', 'Data sent'); res.end();});

    const ip = res.socket.localAddress;
    const port = res.socket.localPort;
    reqCount++;
    LOG('info', 'Serving ' + dataType +' data items: ' + dataArray.length +
        ' to address ' + ip + 'request number: ' + reqCount);
    if(dataType === 'json') {
        ss.push('[');
        for(var i = 0; i < dataArray.length; i++) {
            if(i < dataArray.length - 1) {
                ss.push(JSON.stringify(dataArray[i][1]) + ',');
            }
            else {
                //during last round, don't add , to end
                ss.push(JSON.stringify(dataArray[i][1]));
            }
        }
        ss.push(']');
    }
    else if(dataType === 'csv') {
        ss.push('id,station_id,commodity_id,supply,supply_bracket,buy_price,sell_price,demand,demand_bracket,collected_at\n');
        dataArray.forEach(item => ss.push(item[2]));
    }
    ss.push(null); // end of data
}

// this method displays the default web page which contains the link to the 3hdata
function displayPage(res) {
    res.writeHead(200, {'Content-type':'text/html'});
    res.write('<style>');
    res.write('  h1 {text-align: center;}');
    res.write('  .footer {');
    res.write('    padding: 20px;');
    res.write('    text-align: center;');
    res.write('    background: #ddd;');
    res.write('    margin-top: 20px;');
    res.write('  }');
    res.write('  .cent {');
    res.write('    text-align: center;');
    res.write('  }');
    res.write('</style>');
              
    res.write('<h1>Welcome to eddn listener data download page for Elite Dangerous</h1>');
    res.write('<p>This page currently contains only 3h data from EDDN. Data is being\
constantly updated and thus should be quite current. Optimal solution for this page\
would be to use some kind of crontab or similar and download the file every 3h interval\
so that your data is constantly up to date</p>');
    res.write('<p class="cent" ><a href="/elite/3hdata">3hdata</a> ');
    res.write('<a href="/elite/3hdataCSV">3hdataCSV</a> ');
    res.write('<a href="/elite/24hdataCSV">24hdataCSV</a></p>');
    res.write('<div class="footer">');
    res.write('  <p>Please feel free to contact me if you need further \
support or have improvement ideas, jarkko.vartiainen at googles most \
prominent web mail.com</p>');
    res.write('  <p class="cent" >Eddn listener v.' + VERSION + '</p>');
    res.end();
}
function validate(json, schema) {
    var Ajv = require('ajv');
    var ajv = Ajv({ schemaId: 'auto'});
    ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
    ajv.compile(schema);
    var valid = ajv.validate(json);
    return valid;
}


function loadJsonStorage(storageFile, comJson, cb) {
    LOG('info', 'Loading jsonStorage: ' + storageFile);
    var fs = require('fs');
    var fsr = require('fs-reverse');
    var now = new Date();
    var threehAgo = now.getTime() - 1000*60*60*3;
    if(fs.existsSync(storageFile)) {
        var fInfo = fs.statSync(storageFile);
        LOG('verbose', storageFile + ' is created' + fInfo.birthtime);
        if(fInfo.size === 0) {
            LOG('info', 'Storagefile was empty, maybe old data was purged and nothing remains');
            cb();
            return;
        }
    }

    var rstream = fsr(storageFile);

    var data='';
    okToWrite = false;
    var lineCounter = 0;

    rstream.on('data', line => {
        lineCounter++;
        if(line.length === 0)
           return;

        if(line.split(':')[0] > threehAgo) {
            // split will use only first ":" for splitting, rest are considered
            // as part of the last token
            const time = new Date(Number(line.split(':',1)));
            const json = JSON.parse(
                line.substring(line.indexOf(':') + 1)).message;
            addJsonToJsons(json, time, comJson, () =>{});
        }
        else {
            LOG('info', 'Reading done, destroy stream');
            rstream.destroy(); // reading done, destroy stream
            return;
        }
    });

    rstream.on('error', (err) =>
               LOG('error', 'Error reading json storage file: ' +err));
    rstream.on('end', ()=> {
        var dur = ((new Date()).getTime() - now.getTime()) / 1000;
        LOG('info', 'Data from json storage retreived: ' +
            lineCounter + ' entries read \nof which ' + jsons.length +
            ' were newer than 3h. This took ' + dur + 's');
    });
    rstream.on('close', () => {
        var dur = ((new Date()).getTime() - now.getTime()) / 1000;
        LOG('info', 'Data from json storage retreived: ' + --lineCounter +
            ' entries read in ' + dur + 's');
        cb();
    });
}

// add single json string to a jsons array, also create the csv list from the json
// input: json = parsed json object containing market data, e.g. from eddn
//        time    = timestamp to be given for the json string
//        comJson = commodities json object, from eddb website
//         cb     = callback
function addJsonToJsons(json, time, comJson, cb){
    try {
        var len = Object.keys(json.commodities).length;
    }
    catch(error){
        LOG('warning', 'Error parsing json: ' + error);
        cb();    
        return;
    }
    // data passed schema validation, lets check values against average prices
    var cvsString='';

    // check that prices are sane
    // todo: add more intelligent heuristics or automatic logic for checks
    for(var i = 0; i < len; i++){
        var top = TOP_LIMIT/100 * json.commodities[i].meanPrice +
                json.commodities[i].meanPrice;
        var bot = json.commodities[i].meanPrice - BOT_LIMIT/100 *
                json.commodities[i].meanPrice;
        if(bot < 0) bot = 0;
        
        if(json.commodities[i].buyPrice > 0 && (
            json.commodities[i].buyPrice > top ||
                json.commodities[i].buyPrice < bot ) ||
           json.commodities[i].sellPrice > 0 && (
               json.commodities[i].sellPrice > top ||
                   json.commodities[i].sellPrice < bot)) {
            LOG('debug', json.commodities[i].name + ' avg:' +
                json.commodities[i].meanPrice + ' t:' +
                top + ' b:' +
                bot + ' buy:' +
                json.commodities[i].buyPrice + ' sell:' +
                        json.commodities[i].sellPrice);      
            LOG('warning', 'json price exceed limits, ignoring data');
            return;
        }
        // price was ok, lets check the other fields also
        if(json.commodities[i].stock === undefined ||
           json.commodities[i].stockBracket === undefined ||
           json.commodities[i].demand === undefined ||
           json.commodities[i].demandBracket === undefined) {
            LOG('warning', 'Stock or demand info undefined');
        }
        // all field are at least set,  lets find a match from commodities.json
    }
    cvsString = createCsvString(json, comJson);    
    LOG('silly', 'cvs: \n' + cvsString);
    LOG('debug', '%s - System: %s[%s] commodities: %s',
        time, json.systemName, json.stationName, len);

    jsons.push(new Array());
    jsons[jsons.length-1][0]=time.getTime();
    jsons[jsons.length-1][1]=json;
    jsons[jsons.length-1][2]=cvsString;
    
    LOG('silly', '%s - System: %s, Station: %s - MarketId: ',
        json.timestamp,
        json.systemName,
        json.stationName,
        json.marketId);
    LOG('silly', sprintf('%-30s %8s    %8s    %6s    %6s',
                         'NAME', 'STOCK','DEMAND', 'BUY', 'SELL'));
    var mapping={ 0:'N', 1:'L', 2:'M', 3:'H', '':'N'};
    for(var i = 0; i < len; i++){
        var d = mapping[json.commodities[i].demandBracket];
        if(d == null) d='N';
        LOG('silly', sprintf('%-30s %8s    %8s %s    %6s    %6s %6s',
                             json.commodities[i].name,
                             json.commodities[i].stock,
                             json.commodities[i].demand,
                             d,
                             json.commodities[i].buyPrice,
                             json.commodities[i].sellPrice,
                             json.commodities[i].meanPrice));
    }
    cb();
}

function createCsvString(json, comJson) {
    if(comJson.length === undefined || comJson.length === 0)
        assert(false);
    var csvString='';
    var found = false;
    var stationId = matchStation(json);
    if(stationId === null) {
        LOG('warning', 'No id found for station: ' + json.stationName + '/' +
            json.systemName);
        stationId='';
    }
    
    for(var i = 0; i < json.commodities.length; i++) {
        for(var j = 0; j < comJson.length; j++)
        {
            //id,station_id,commodity_id,supply,supply_bracket,buy_price,sell_price,
            //demand,demand_bracket,collected_at
            //id is not needed by Trade Dangerous or is set by it -> leave it empty.
            if(json.commodities[i].name.toUpperCase() ===
               comJson[j].name.toUpperCase()){
                csvString += ',';
                csvString += stationId + ',';
                csvString += comJson[j].id + ',';
                csvString += json.commodities[i].stock + ',';
                csvString += json.commodities[i].stockBracket + ',';
                csvString += json.commodities[i].buyPrice + ',';
                csvString += json.commodities[i].sellPrice + ',';
                csvString += json.commodities[i].demand + ',';
                csvString += json.commodities[i].demandBracket + ',';
                csvString += Date.parse(json.timestamp) / 1000 + '\n'; 
                found=true;
                break;
            }
        }
        if(!found) {
            LOG('warning', 'looking for: ' + json.commodities[i].name +
                ' no match found');
        }
    }
    return csvString;
}


function upload24h(res, storageFile, comJson) {
    var fs = require('fs');
    if(!fs.existsSync(storageFile)) {
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end('No eddn data available');
        return;
    }
    // https://stackoverflow.com/questions/34687387/how-can-i-stream-a-json-array-from-nodejs-to-postgres
    res.writeHead(200, {'Content-Type': 'application/force-download',
        'Content-disposition':'attachment; filename=24hdata.csv.gz'});
    // Create pipe that will stream and gzip data to client
    // i.e. create data "[{json1{json2}...{jsonN}] or send the csv data.
    // client then has to unzip the received file.
    var cvsTrans = new xform(comJson);
    cvsTrans.pipe(zlib.createGzip()).pipe(res);
    const ip = res.socket.localAddress;
    const port = res.socket.localPort;
    reqCount++;
    LOG('info', 'Serving 24h json data items' +
        ' to address ' + ip + 'request number: ' + reqCount);
    cvsTrans.write('id,station_id,commodity_id,supply,supply_bracket,buy_price,sell_price,demand,demand_bracket,collected_at\n');
    var readStream = fs.createReadStream(storageFile).pipe(cvsTrans);
    readStream.on('end', () => {
        LOG('verbose', 'All data read from file');
    });
    readStream.on('error', (err) => LOG('error', 'Failed to read 24h data from disk: ' + err));
    readStream.on('close', () => LOG('debug', '24h readstream closed'));
}

// Function will try to find station matching the incoming eddn station.
// If match is found, it will add proper id to the data, otherwise null
// will return.
// Input:
//        json  = json containing eddn sell data, i.e. json.message object
// output:
//        id    = ID number of the station where sell data was collected or
//                null if no match is found
function matchStation(json){
    if(json.stationName+'/'+json.systemName in stationMap)
        return stationMap[json.stationName+'/'+json.systemName].id;
    return null;
}

var Transform = require('stream').Transform;

function xform (comJson) {
    let _buff='';
    let _comJson = comJson;
    let _firstLine = true;

    return new Transform( {
        transform(chunk, enc, callback)
        {
            _buff += chunk.toString();
            while(_buff.indexOf('\n') !== -1) {
                const line = _buff.slice(0, _buff.indexOf('\n'));
                _buff = _buff.substr(_buff.indexOf('\n') + 1);
                if(_firstLine) {
                    _firstLine = false;
                    this.push(line + '\n'); // first linei is the header line
                }
                else {
                    var json = JSON.parse(line.substring(line.indexOf(':') + 1));
                    // parse commodities to csv format
                    if(json.commodities === undefined){
                        json=json.message; 
                    }
                    var csvString = createCsvString(json, _comJson);
                    this.push(csvString);
                }
            }   
            callback(); 
        }
    });
}
