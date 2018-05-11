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
const TOP_LIMIT=1500; //% how many percents sell/buy price can be higher than mean price
const BOT_LIMIT=1500; //% how many percents can sell/buy price be lower than mean price 

function downloadPage(res, dataArray) {
    if(dataArray.length == 0) {
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end('No eddn data available');
        return;
    }
    var ss = new stream.Readable();
    // https://stackoverflow.com/questions/34687387/how-can-i-stream-a-json-array-from-nodejs-to-postgres
    res.writeHead(200, {'Content-Type': 'application/force-download',
        'Content-disposition':'attachment; filename=3hdata.json.gz'});

    // Create pipe that will stream and gzip the individual jsons to client
    // i.e. create data "[{json1{json2}...{jsonN}].
    // client then has to unzip the received file and then it will have
    // array of jsons, where each json is a single eddn commodity json
    ss.pipe(zlib.createGzip())
        .on('close',() =>console.log('zip done'))
        .pipe(res)
        .on('finish', () => {console.log('Done'); res.end();});
    
    ss.push('[');
    console.log('streaming data...' + dataArray.length);
    dataArray.forEach(item => ss.push(JSON.stringify(item[1])));
    ss.push(']');
    ss.push(null); // end of data
}

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
    res.write('<p><a href="elite/3hdata">3hdata</a></p>');
    res.write('<div class="footer">');
    res.write('  <p>Please feel free to contact me if you need further support or have improvement ideas,\
jarkko.vartiainen at googles most prominent web mail.com</p>');
    res.end();
}
var jsons = new Array();
console.log('Creating web server');
var server = http.createServer(function (req, res) {
    if (req.method.toLowerCase() == 'get') {
        var u = url.parse(req.url).pathname;
        if(u === "/elite"|| u === "/elite/") {
            displayPage(res);
            return;
        }
        else if(u==="/elite/3hdata") {
            downloadPage(res, jsons);
            return;
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

var DEBUG=2;
var schema1 = null;
var schema3 = null;
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
                useSchema(payload, schema1, header, data);
            
        }
        else if(schemaRef === 'https://eddn.edcd.io/schemas/commodity/3') {
            if(schema3 === null)
                downloadSchema(schemaRef, payload, header, data );
            else
                useSchema(payload, schema3, header, data)
        }
        else {
            // console.log('unsupported schema in json "%s"', schemaRef); 
            return;
        }
    });
});
server.listen(1185);
console.log("server listening on 1185");

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
                useSchema(rawJson, schema, header, data);
            });
            response.on('error', function() {
                console.log("Failed to download schema from " + schemaUrl);
            });
        }
        else
            console.log("Schema url returned bad response " + response.statusCode);                   
    });
}

function useSchema(rawJson, schema, header, data) {
    // validate data, i.e. so that all fields are correct
    if(!validate(rawJson, schema))
        return;

    // data passed schema validation, lets check the values against average prices
    var len = Object.keys(data.commodities).length;
    var time = new Date(Date.parse(data.timestamp));
    for(var i=0; i < len; i++){
        var top = TOP_LIMIT/100 * data.commodities[i].meanPrice + data.commodities[i].meanPrice;
        var bot = data.commodities[i].meanPrice - BOT_LIMIT/100 * data.commodities[i].meanPrice;
        bot > 0 ? bot : bot=0;
        
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
    }
    console.log('%s-%s - System: %s[%s] commodities: %s',
                header.gatewayTimestamp, time,
                data.systemName, data.stationName, len);

    jsons.push(new Array());
    jsons[jsons.length-1][0]=time.getTime();
    jsons[jsons.length-1][1]=rawJson;
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

function validate(json, schema) {
    var Ajv = require('ajv');
    var ajv = Ajv({ schemaId: 'auto'});
    ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
    ajv.compile(schema);
    var valid = ajv.validate(json);
    return valid;
}
