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
    console.log('Encode', proto.name, data);
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
        /*
            let protoMask = 0x80000000;
            let msgType = 21;
            // Bitwise OR assignment
            msgType = msgType | protoMask; // -2147483627
            // Unsigned right shift assignment 
            msgType = msgType >>> 0; // 2147483669
            
            // equivalent to (Rust):
            let proto_mask: u32 = 0x80000000;
            let msg_type: i32 = 21;
            let msg_type = msg_type as u32 | proto_mask;
        */
        msgType = (msgType | PROTO_MASK) >>> 0;
        protoBufHeader.job_id_source = sourceJobId;
        let protoHeader = encodeProto(Schema.CMsgProtoBufHeader, protoBufHeader);
        header = Buffer.alloc(8);
        header.writeUInt32LE(msgType, 0); // 4
        header.writeInt32LE(protoHeader.length, 4); // 4
        // 4 + 4 + protoHeader.length
        header = Buffer.concat([header, protoHeader]);
    } else {
        header = ByteBuffer.allocate(18, ByteBuffer.LITTLE_ENDIAN);
        header.writeUint16(1); // 2
        header.writeUint64(JOBID_NONE); // 8
        header.writeUint64(sourceJobId); // 8
        // 2 + 8 + 8
        header = header.flip().toBuffer();
    }
    
    logBuffer('GC Header', header);
    logBuffer('GC Payload', payload);

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

    if (protobufs[header.msg]) {
        header.proto = header.proto || {};
        body = encodeProto(protobufs[header.msg], body);
    } else if (ByteBuffer.isByteBuffer(body)) {
        body = body.toBuffer();
    }
    
    let jobIdSource = null;
    
    if (callback) {
        jobIdSource = ++currentJobID;
        jobs[jobIdSource] = callback;
    }
    
    // Make the header
    let headerBuffer;
    
    if (header.msg == EMsg.ChannelEncryptResponse) {
        // unused in this example
        // headerBuffer = ByteBuffer.allocate(4 + 8 + 8, ByteBuffer.LITTLE_ENDIAN);
        // headerBuffer.writeUint32(header.msg);
        // headerBuffer.writeUint64(header.targetJobID || JOBID_NONE);
        // headerBuffer.writeUint64(jobIdSource || header.sourceJobID || JOBID_NONE);
    } else if (header.proto) {
        header.proto.client_sessionid = sessionID || 0;
        header.proto.steamid = steamID.getSteamID64();
        header.proto.jobid_source = jobIdSource || header.proto.jobid_source || header.sourceJobID || JOBID_NONE;
        header.proto.jobid_target = header.proto.jobid_target || header.targetJobID || JOBID_NONE;
    
        let headerProtobuf = encodeProto(Schema.CMsgProtoBufHeader, header.proto);
        
        headerBuffer = ByteBuffer.allocate(4 + 4 + headerProtobuf.length, ByteBuffer.LITTLE_ENDIAN);
        headerBuffer.writeUint32(header.msg | PROTO_MASK);
        headerBuffer.writeUint32(headerProtobuf.length);
        headerBuffer.append(headerProtobuf);
    } else {
        // this is the standard non-protobuf extended header
        headerBuffer = ByteBuffer.allocate(4 + 1 + 2 + 8 + 8 + 1 + 8 + 4, ByteBuffer.LITTLE_ENDIAN);
        headerBuffer.writeUint32(header.msg);
        headerBuffer.writeByte(36);
        headerBuffer.writeUint16(2);
        headerBuffer.writeUint64(header.targetJobID || JOBID_NONE);
        headerBuffer.writeUint64(jobIdSource || header.sourceJobID || JOBID_NONE);
        headerBuffer.writeByte(239);
        headerBuffer.writeUint64(steamID.getSteamID64());
        headerBuffer.writeUint32(sessionID || 0);
    }
    
    // the final step - these are the bytes actually sent to the connection
    let buffer = Buffer.concat([headerBuffer.flip().toBuffer(), body]);
    
    return buffer;
}

function logBuffer(name, buffer) {
    console.log(`${name}:`, Uint8Array.from(buffer));
}

logBuffer('Final message', removeGiftedBy(5845839485));

