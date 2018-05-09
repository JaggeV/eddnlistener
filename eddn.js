var zmq     = require('zmq')
  , sock    = zmq.socket('sub')
  , zlib    = require('zlib')
  , sprintf = require("sprintf-js").sprintf
  , http    = require('http')
  , url     = require('url')
  , stream  = require('stream')
;

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
            //console.log('using old schema "%s"', schemaRef);
        }
        else if(schemaRef === 'https://eddn.edcd.io/schemas/commodity/3') {
            //console.log('using new schema "%s"', schemaRef);
        }
        else {
            //console.log('unsupported schema in json "%s"', schemaRef);
            return;
        }
        var len = Object.keys(data.commodities).length;
        var time = new Date(Date.parse(data.timestamp));

        console.log('%s-%s - System: %s[%s] commodities: %s',
             header.gatewayTimestamp, time, data.systemName, data.stationName, len);
        jsons.push(new Array());
        jsons[jsons.length-1][0]=time.getTime();
        jsons[jsons.length-1][1]=payload;
        console.log("jsons size %s", jsons.length);

        // next remove all items older than 3 hours from the array
        var i = 0;
        while(jsons[i][0]<Date.now() - 3*60*60*1000)
            i++;
        jsons.splice(0,i);


// todo: in case of restart, write 3h array to to a file ar an hour interval
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
    });
});
server.listen(1185);
console.log("server listening on 1185");
