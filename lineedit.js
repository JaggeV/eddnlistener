var fs = require('fs'),
    transform = require('stream').Transform,
    util = require('util')
;

// RemoveLineIf
// Remove line from stream based on condition given to this method
// options:
// lineFilt  = method to determine if line is deleted or not, i.e.
//             bool logic(line); with return true, line is pushed back
//             into stream.
// options   = options passed to Transform
function RemoveLineIf(lineFilt, options) {
    // allow user without new
    if (! (this instanceof RemoveLineIf)) {
        return new RemoveLineIf(lineFilt, options);
    }
    // init Transform

    transform.call(this, options);
    this._buff = '';
    this.lineFilt = lineFilt;
};
util.inherits(RemoveLineIf, transform);

//RemoveLineIf Transform stream
// params:
// chunk    = data chunk coming from stream
// encoding = encoding used to interpret incoming data (utf8 maybe)
// done     = callback when all is done
var counter=0;
RemoveLineIf.prototype._transform = function(chunk, encoding, cb) {
    this._buff += chunk.toString();

    // check if string has newline symbol, i.e. whole line found
    while(this._buff.indexOf('\n') !== -1) {

        var line = this._buff.slice(0, this._buff.indexOf('\n')+1);
        this._buff = this._buff.substr(this._buff.indexOf('\n')+1);
        //only push those lines that the line filter accepts

        if(this.lineFilt(line))
        {
            this.push(line);
        }
    }
    cb(null);
};

exports.lineFilter = function (inFile, filter, cb) {
    filter = typeof filter !== null ? filter : checkLine;
    var outFile = inFile + '_';

    var rs = fs.createReadStream(inFile);

    var output = fs.createWriteStream(outFile);

    var filter = new RemoveLineIf(filter);
    rs.pipe(filter).pipe(output);

    rs.on('error', err => handleError(err, cb).bind(this));
    filter.on('error', err => handleError(err, cb).bind(this));
    output.on('error', err=> handleError(err, cb).bind(this));

    output.on('close', () => {
        if(!fs.existsSync(outFile)){
            cb(null);
            return;
        }
        fs.unlinkSync(inFile);
        fs.renameSync(outFile, inFile);
        cb(null);
    });
};

function handleError(err, cb) {
    rs.unpipe(filter).unpipe(output);
    output.end();
    console.log('LineFilter pipes failed: ' + err);
    cb(err);
}

function checkLine(line) {
    if(Number(line.split(':')[0]) > 5){
        return true;
    }
    return false;
}
