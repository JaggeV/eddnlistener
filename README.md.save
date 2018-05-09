# eddnlistener
Elite dangerous eddn (elite dynamic data network) listener using nodejs
9.5.2018 by Jarkko Vartiainen.

This little nodejs program will setup a http server for you and then
will start listening EDDN traffic. It will then start compiling trade data
from that traffic and will store it for 3 hours. After 3 hours, the older data
will get deleted while newer gets in. You can set a e.g. cron job that will
download this data every 3 hours (maybe 2.9h) and update your Trade Dangerous
database with all the latest trade information.

TODO: Suitable format for the trade data. Currently the data is served exactly
like EDDN traffic is, namely JSON format. The data you receive are just EDDN 
commodity messages in jSON array like this
[{json1}{json2}...{jsonN}]. You then have to parse this data for your 
trade database any way you see fit. 

This data also currently can contain duplicates and errors, the data is not
yet sanitized in any way, altough it might be that I will check each EDDN json
field for errors and drop invalid messages, but it is not done yet.


