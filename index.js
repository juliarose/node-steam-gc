const STEAM_APPID = 440;
const Language = require('./language.js');
const TFSchema = require('./tf-protobufs/generated/_load.js');
const Schema = require('./steam-protobufs/generated/_load.js');
const EMsg = require('./enums/EMsg.js');
const ByteBuffer = require('bytebuffer');
const SteamID = require('steamid');

const protobufs = {};

protobufs[EMsg.ClientToGC] = Schema.CMsgGCClient;
protobufs[EMsg.ClientFromGC] = Schema.CMsgGCClient;

// max u64
const JOBID_NONE = '18446744073709551615';
const PROTO_MASK = 0x80000000;
const steamID = new SteamID('76561198006409530');

let currentJobID = 0;
let currentGCJobID = 0;
let sessionID = 1;
let jobs = {};
let jobsGC = {};

function encodeProto(proto, data) {
    return proto.encode(data).finish();
}

function removeGiftedBy(item_id) {
    return sendGC(Language.RemoveGiftedBy, TFSchema.CMsgGCRemoveCustomizationAttributeSimple, {
        item_id
    });
}

function sendGC(msgType, protobuf, body) {
    if (protobuf) {
        return sendToGC(STEAM_APPID, msgType, {}, protobuf.encode(body).finish());
    }
    
    // This is a ByteBuffer
    return sendToGC(STEAM_APPID, msgType, null, body.flip().toBuffer());
}

function sendToGC(appid, msgType, protoBufHeader, payload, callback) {
    let sourceJobId = JOBID_NONE;
    
    if (typeof callback === 'function') {
        sourceJobId = ++currentGCJobID;
        
        jobsGC[sourceJobId] = callback;
    }
    
    let header;
    
    if (protoBufHeader) {
        msgType = (msgType | PROTO_MASK) >>> 0;
        protoBufHeader.job_id_source = sourceJobId;
        let protoHeader = encodeProto(Schema.CMsgProtoBufHeader, protoBufHeader);
        header = Buffer.alloc(8);
        header.writeUInt32LE(msgType, 0);
        header.writeInt32LE(protoHeader.length, 4);
        header = Buffer.concat([header, protoHeader]);
    } else {
        header = ByteBuffer.allocate(18, ByteBuffer.LITTLE_ENDIAN);
        header.writeUint16(1); // header version
        header.writeUint64(JOBID_NONE);
        header.writeUint64(sourceJobId);
        header = header.flip().toBuffer();
    }

    return send({
        msg: EMsg.ClientToGC,
        proto: {
            routing_appid: appid
        }
    }, {
        appid,
        msgtype: msgType,
        payload: Buffer.concat([header, payload])
    });
}

function send(emsgOrHeader, body, callback) {
    // header fields: msg, proto, sourceJobID, targetJobID
    let header = typeof emsgOrHeader === 'object' ? emsgOrHeader : {"msg": emsgOrHeader};
    let emsg = header.msg;

    const Proto = protobufs[emsg];
    
    if (Proto) {
        header.proto = header.proto || {};
        body = encodeProto(Proto, body);
    } else if (ByteBuffer.isByteBuffer(body)) {
        body = body.toBuffer();
    }
    
    let jobIdSource = null;
    
    if (callback) {
        jobIdSource = ++currentJobID;
        jobs[jobIdSource] = callback;
    }
    
    let emsgName = EMsg[emsg] || emsg;
    
    if (emsg == EMsg.ServiceMethodCallFromClient && header.proto && header.proto.target_job_name) {
        emsgName = header.proto.target_job_name;
    }
    
    // Make the header
    let hdrBuf;
    
    if (header.msg == EMsg.ChannelEncryptResponse) {
        // since we're setting up the encrypted channel, we use this very minimal header
        hdrBuf = ByteBuffer.allocate(4 + 8 + 8, ByteBuffer.LITTLE_ENDIAN);
        hdrBuf.writeUint32(header.msg);
        hdrBuf.writeUint64(header.targetJobID || JOBID_NONE);
        hdrBuf.writeUint64(jobIdSource || header.sourceJobID || JOBID_NONE);
    } else if (header.proto) {
        // if we have a protobuf header, use that
        header.proto.client_sessionid = sessionID || 0;
        header.proto.steamid = steamID.getSteamID64();
        header.proto.jobid_source = jobIdSource || header.proto.jobid_source || header.sourceJobID || JOBID_NONE;
        header.proto.jobid_target = header.proto.jobid_target || header.targetJobID || JOBID_NONE;
        let hdrProtoBuf = encodeProto(Schema.CMsgProtoBufHeader, header.proto);
        hdrBuf = ByteBuffer.allocate(4 + 4 + hdrProtoBuf.length, ByteBuffer.LITTLE_ENDIAN);
        hdrBuf.writeUint32(header.msg | PROTO_MASK);
        hdrBuf.writeUint32(hdrProtoBuf.length);
        hdrBuf.append(hdrProtoBuf);
    } else {
        // this is the standard non-protobuf extended header
        hdrBuf = ByteBuffer.allocate(4 + 1 + 2 + 8 + 8 + 1 + 8 + 4, ByteBuffer.LITTLE_ENDIAN);
        hdrBuf.writeUint32(header.msg);
        hdrBuf.writeByte(36);
        hdrBuf.writeUint16(2);
        hdrBuf.writeUint64(header.targetJobID || JOBID_NONE);
        hdrBuf.writeUint64(jobIdSource || header.sourceJobID || JOBID_NONE);
        hdrBuf.writeByte(239);
        hdrBuf.writeUint64(steamID.getSteamID64());
        hdrBuf.writeUint32(sessionID || 0);
    }
    
    // the final step - these are the bytes actually sent to the connection
    let outputBuffer = Buffer.concat([hdrBuf.flip().toBuffer(), body]);
    
    // actually output the whole thing to console :)
    return Uint8Array.from(outputBuffer);
}

console.log(removeGiftedBy(1));