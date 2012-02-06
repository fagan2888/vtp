var fs = require('fs');
var zlib = require('zlib');

var wiretype={'LENGTH':2,
              'VARINT':0};

function more_bytes(bb){
  return (bb&0x80)==0x80;
}
function strip_msb(bb){
  return 0x7f&bb;
}
function get_wire_type(val){
  return 0x07&val;
}
function get_field_number(val){
  return val>>3;
}


function readVarint( ary, offset, callback ){
  var i=offset;
  var bytes = [strip_msb(ary[i])];
  while( more_bytes(ary[i]) && i<ary.length-1 ){
    i += 1;
    bytes.push( strip_msb(ary[i]) );
  }

  var val = 0;
  for(i=0; i<bytes.length; i++){
    val += bytes[i]<<(7*i);
  }
  return [val,i];
}

function readField(buf,offset){
  var nread=0;

  var fielddef = readVarint(buf,offset);
  var wire_type = get_wire_type(fielddef[0]);
  var field_number = get_field_number(fielddef[0]);
  nread += fielddef[1];

  var val = null;
  if(wire_type==wiretype.LENGTH){
    var strlendef = readVarint(buf,offset+nread);
    var strlen = strlendef[0];
    nread += strlendef[1]; 
    val = buf.slice(offset+nread,offset+nread+strlen);
    nread += strlen;
  } else if(wire_type==wiretype.VARINT) {
    valdef = readVarint( buf, offset+nread );
    val = valdef[0];
    nread += valdef[1];
  }

  return [field_number, val, nread];
}

function Message(buf){
  this.fields = {}

  var offset=0;
  while(offset<buf.length){
    var field = readField( buf, offset );
    var ftag=field[0].toString();
    var fval=field[1];
    var flen=field[2];

    if(this.fields[ftag] === undefined){
      this.fields[ftag] = []
    }

    this.fields[ftag].push(fval);
    offset += flen;
    
  }

  this.val = function(tag){
    if(!this.hasField(tag))
      return null;
    return this.fields[tag.toString()][0];
  }
  this.vals = function(tag){
    if(!this.hasField(tag))
      return []
    return this.fields[tag.toString()];
  }
  this.hasField = function(tag){
    return this.fields[tag.toString()]!==undefined
  }
}

function BlobHeader(message){
  this.type = message.val(1).toString();
  this.indexdata = message.val(2);
  this.datasize = message.val(3);
}

function Fileblock(fd, fileoffset){
  this.fd=fd;
  this.fileoffset=fileoffset;
  this.headersize=null;
  this.payloadsize=null;
  this.len=null;
  this.header=null;
  this.payload=null;

  var metathis=this;

  this.readHeader = function(callback){
    // read header length
    var buf = new Buffer(4);
    fs.read(fd,buf,0,4,this.fileoffset,function(err,bytesRead,buffer){

      // read the header
      metathis.headersize = buf.readUInt32BE(0);
      var headerbuf = new Buffer(metathis.headersize);
      fs.read(fd,headerbuf,0,metathis.headersize,metathis.fileoffset+4,function(err,bytesRead,buffer){

        var headerMessage = new Message( headerbuf );
        metathis.header= new BlobHeader(headerMessage);
        metathis.payloadsize = metathis.header.datasize;
        metathis.size=4+metathis.headersize+metathis.payloadsize;
        callback(metathis);
      });
    });
  }

  this.convertPayloadMessage = function(payload){
    var messageType={"OSMHeader":HeaderBlock,
                     "OSMData":PrimitiveBlock};

    return new messageType[this.header.type](payload);
  }

  this.readPayload = function(callback){
    // read the blob payload
    var blobbuf = new Buffer(metathis.payloadsize);
    fs.read(fd,blobbuf,0,metathis.payloadsize,metathis.fileoffset+metathis.headersize+4,function(err,bytesRead,buffer){

      var packedBlobMessage = new Message( blobbuf );

      if( packedBlobMessage.hasField(1) ) {
        metathis.payload=metathis.convertPayloadMessage(new Message(packedBlobMessage.val(1)));
        callback( metathis );
      } else if( packedBlobMessage.hasField(3) ) {
        zlib.unzip(packedBlobMessage.val(3),function(err,buffer){
          var unpackedBlobMessage = new Message( buffer );
          metathis.payload = metathis.convertPayloadMessage(unpackedBlobMessage);
          callback( metathis );
        });
      }
    });
  }

  this.read = function(callback){
    this.readHeader(function(fb){
      metathis.readPayload(callback);
    });
  }
}

function readRepeated(buf){
  ret = []

  var i=0;
  while(i<buf.length){
    var valdef = readVarint(buf,i);
    var val=valdef[0];
    ret.push( val );
    i += valdef[1];
  }

  return ret;
}

function StringTable(message){
  this.data = message.vals(1)
  this.getString = function(i){
    return this.data[i].toString();
  }
}

function DenseInfo(message) {
  this.version = readRepeated( message.val(1) );
  this.timestamp = readRepeated( message.val(2) );
  this.changeset = readRepeated( message.val(3) );
  this.uid = readRepeated( message.val(4) );
  this.user_sid = readRepeated( message.val(5) );
}

function DenseNodes(message){
  this.ids = readRepeated( message.val(1) );
  this.denseinfo = new DenseInfo( new Message( message.val(5) ) );
  this.lat = readRepeated( message.val(8) );
  this.lon = readRepeated( message.val(9) );
  this.keys_vals = readRepeated( message.val(10) );
}

function PrimitiveGroup(message){
  if(message.hasField(2))
    this.dense = new DenseNodes( new Message( message.val(2) ) )
}

function PrimitiveBlock(message){
  this.stringtable = new StringTable( new Message( message.val(1) ) );
  this.primitivegroup = new PrimitiveGroup( new Message( message.vals(2)[0] ) );
}

function HeaderBlock(message){
}

function FileBlockFile(path){
  this.read = function(callback){
    fs.open( path, "r", function(err,fd) {
      var stats = fs.statSync( path );

      var offset=0;
      var onblobread = function(fb){
        if(fb){
          offset += fb.size;
          callback(fb);
        }

        if(offset==stats.size)
          return;

        var fileblock = new Fileblock(fd,offset);
        fileblock.readHeader( onblobread );
      }
      onblobread(null,0);
    });
  }
}

var path="/storage/maps/boston.osm.pbf";
var fileblockfile = new FileBlockFile(path);

var i=0;
fileblockfile.read(function(fb){
  i++;
  if(i==807){
    fb.readPayload(function(fb){
      console.log(fb,fb.payload.stringtable.getString(3));
    });
  }
});
