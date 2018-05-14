var zmq     = require('zmq')
  , sock    = zmq.socket('sub')
  , zlib    = require('zlib')
  , sprintf = require("sprintf-js").sprintf
  , http    = require('http')
  , https   = require('https')
  , url     = require('url')
  , stream  = require('stream')
;
// these next variables can be used to tune item price checks
const TOP_LIMIT = 1500; //% how many percents sell/buy price can be higher than mean price
const BOT_LIMIT = 1500; //% how many percents can sell/buy price be lower than mean price 

// other program defining constant
// define the port where you want this server to run, can be also 80 if you don't have
// any other (web)service running in that port. E.g. localhost:1185/elite or if port 80,
// then just localhost/elite to access your server
const PORT = 1185; 

// log level, the higher the number, the more verbose the logs will be
var DEBUG=2;

//how long same commodities file is used before new one is downloaded
//commodities file is used to obtain info about commodity ids.
const COMSEXPIRE = 1000*60*60*24*7; //in milliseconds
const COMFILE = 'commodities.json';

var jsons = new Array(); // this variable will store all the received eddn jsons
// schema files will be buffered after first download, schema1 is old address
// and schema3 is new address, schema1 is probably obsolete.
var schema1 = null;
var schema3 = null;

var commodities = {time : '', data : ''};

getCommodities(); //if this fails totally, you can download commodities.json
// into eddn.js directory getCommodities tries to use that file directly.

// try updating commodity.json at COMSEXPIRE interval
// to force update, just delete commodity.json before running eddn.js
const intervalObj = setInterval(updateCommodities, COMSEXPIRE);

console.log('Creating web server');
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
console.log('waiting for updates...');
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
            // console.log('unsupported schema in json "%s"', schemaRef); 
            return;
        }
    });
});
server.listen(PORT);
console.log("server listening on " + PORT);

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
                console.log("Failed to download schema from " + schemaUrl);
            });
        }
        else
            console.log('Schema url returned bad response ' + response.statusCode);                   
    });
}

// Download commodities.json from eddb.io, contains unique commodity id for all items.
// Save the file to drive for later use. If the file is older than a week, redownload
// to see if anything has changed. 
function getCommodities() {
    var fs = require('fs');
    var comUrl = 'https://eddb.io/archive/v5/commodities.json';
    var schema='';
    
    if (fs.existsSync(COMFILE)) {
        var fInfo = fs.statSync(COMFILE);
        var now = new Date();
        var fileDate = new Date(fInfo.mtime);
        console.log('commodities.json age: ' + fileDate);
        if(now - fileDate < COMSEXPIRE) {//time diff is in milliseconds
            console.log('Using existing commodities.json');
            fs.readFile(COMFILE, (err, data) => {
                if(err) {
                    console.log('Failed to open ' + COMFILE + 'due to ' + err);
                    fs.unlink(COMFILE);
                    getCommodities();
                }
                commodities.time = fileDate;
                commodities.data = JSON.parse(data);
                commodities.data = convertCommodities(commodities.data);
            });
        }
        else {
            // existing file is too old
            fs.unlink(COMFILE);
            getCommodities();
        }
    }
    else {
        // file did not exists, thus need to download it
        console.log(COMFILE + ' did not exist, downloading it');
        const req = https.get(comUrl, function(response) {
            if(response.statusCode === 200) {
                response.on('data', function(chunk) {
                    commodities.data += chunk;
                });
                response.on('end', function() {
                    commodities.time = new Date();
                    fs.writeFile(COMFILE, commodities.data, err => {
                        if(err)
                        console.log('Failed to write ' + COMFILE + ' to drive');
                        else
                            console.log('Saved ' + COMFILE);
                    });
                    commodities.data = JSON.parse(commodities.data);
                    commodities.data = convertCommodities(commodities.data);
                });
                response.on('error', function() {
                    console.log('Failed to download ' + COMFILE + ' from ' + comUrl);
                });
            }
            else
                console.log(COMFILE + ' url returned bad response ' + response.statusCode);                   
        });
    }
}

// This will check if commodities.json has expires and will delete the old
// file and then calls getCommodities to update the file to more current state
function updateCommodities() {
    var now = new Date();
    if(now - commodities.time > COMSEXPIRE)
    {
        var fs = require('fs');
        fs.unlink(COMFILE);
        commodities.time = '';
        getCommodities();
    }
}

// this method will convert commodities.json commodities names to names
// that eddn network provides, .e.g. Narcotics become BasicNarcotics etc...
function convertCommodities(comJson) {
    // todo: get rid of these hard coded conersions and use
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
    // validate data, i.e. so that all fields are correct
    if(!validate(rawJson, schema))
        return;

    // data passed schema validation, lets check the values against average prices
    var len = Object.keys(data.commodities).length;
    var time = new Date(Date.parse(data.timestamp));
    //id,station_id,commodity_id,supply,supply_bracket,buy_price,sell_price,demand,demand_bracket,collected_at
    //id is not needed by Trade Dangerous or is set by it. Thus leave it empty.
    var cvsString=''; 
    for(var i=0; i < len; i++){
        var top = TOP_LIMIT/100 * data.commodities[i].meanPrice + data.commodities[i].meanPrice;
        var bot = data.commodities[i].meanPrice - BOT_LIMIT/100 * data.commodities[i].meanPrice;
        if(bot < 0) bot = 0;
        
        if(data.commodities[i].buyPrice > 0 && (
             data.commodities[i].buyPrice > top ||
             data.commodities[i].buyPrice < bot) ||
           data.commodities[i].sellPrice > 0 && (
             data.commodities[i].sellPrice > top ||
                   data.commodities[i].sellPrice < bot)) {
            console.log(data.commodities[i].name + ' avg:' + data.commodities[i].meanPrice + ' t:' +
                        top + ' b:' +
                        bot + ' buy:' +
                        data.commodities[i].buyPrice + ' sell:' + data.commodities[i].sellPrice);      
            console.log("json price exceed limits, ignoring data");
            return;
        }
        // price was ok, lets find a match from commodities.json
        var found=false;
        for(var j = 0; j < comJson.length; j++)
        {
            if(data.commodities[i].name.toUpperCase()  === comJson[j].name.toUpperCase()) {
                cvsString += ',';
                cvsString += data.marketId + ',';
                cvsString += comJson[j].id + ',';
//                cvsString += comJson[j].ed_id + ',';

//                cvsString += data.commodities[i].commodityId + ',';
                cvsString += data.commodities[i].stock + ',';
                cvsString += data.commodities[i].stockBracket + ',';
                cvsString += data.commodities[i].buyPrice + ',';
                cvsString += data.commodities[i].sellPrice + ',';
                cvsString += data.commodities[i].demand + ',';
                cvsString += data.commodities[i].demandBracket + ',';
                cvsString += Date.parse(data.timestamp) + '\n'; 
                found=true;
                break;
            }
        }
        if(!found)
            console.log('looking for: ' + data.commodities[i].name +
                        ' no match found');
    }
//    console.log('cvs: ' + cvsString);
    console.log('%s-%s - System: %s[%s] commodities: %s',
                header.gatewayTimestamp, time,
                data.systemName, data.stationName, len);

    jsons.push(new Array());
    jsons[jsons.length-1][0]=time.getTime();
    jsons[jsons.length-1][1]=rawJson;
    jsons[jsons.length-1][2]=cvsString;;

    console.log("jsons size %s", jsons.length);
    
    // next remove all items older than 3 hours from the array
    var i = 0;
    while(jsons[i][0]<Date.now() - 3*60*60*1000)
        i++;
    jsons.splice(0,i);
    
    // todo: in case of restart, write 3h array to to a file at an hour interval
    if(DEBUG>3) {
        console.log('%s - System: %s, Station: %s - MarketId: ',
                data.timestamp,
                    data.systemName,
                    data.stationName,
                    data.marketId);
        console.log(sprintf('%-30s %8s    %8s    %6s    %6s', 'NAME', 'STOCK','DEMAND', 'BUY', 'SELL'));
        var mapping={ 0:'N', 1:'L', 2:'M', 3:'H', '':'N'};
        for(var i=0; i < len; i++){
            var d = mapping[data.commodities[i].demandBracket];
            if(d == null) d='N';
            console.log(sprintf('%-30s %8s    %8s %s    %6s    %6s %6s',
                                data.commodities[i].name,
                                data.commodities[i].stock,
                                data.commodities[i].demand,
                                d,
                                data.commodities[i].buyPrice,
                                data.commodities[i].sellPrice,
                                data.commodities[i].meanPrice));
        }
    }    
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
        .on('close',() =>console.log('zip done'))
        .pipe(res)
        .on('finish', () => {console.log('Done'); res.end();});

    console.log('streaming data...' + dataArray.length);
    if(dataType === 'json') {
        ss.push('[');
        dataArray.forEach(item => ss.push(JSON.stringify(item[1])));
        ss.push(']');
    }
    else if(dataType === 'csv') {
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
    res.write('<p class="cent" ><a href="elite/3hdata">3hdata</a> ');
    res.write('<a href="elite/3hdataCSV">3hdataCVS</a></p>');
    res.write('<div class="footer">');
    res.write('  <p>Please feel free to contact me if you need further support or have improvement ideas,\
jarkko.vartiainen at googles most prominent web mail.com</p>');
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
