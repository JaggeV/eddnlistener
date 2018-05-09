# eddnlistener
Elite dangerous eddn (elite dynamic data network) listener using nodejs

This program can be used to download EDDN data. It stores data from the last 3h
and user can download the data at any moment. The data gets updated continuously 
so that 3h older data gets deleted and newer data gets stored.

Data is downloaded in gzip format and gunzipped data is an array of JSONs, like 
so: [{json1}{json2}...{jsonN}]. The JSONs themselves are raw data from EDDN and
currently can contain errors and duplicates. 


