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

function coerceToLong(num, signed) {
    if (typeof num !== 'string') {
        return num;
    }
    
    return new ByteBuffer.Long.fromString(num, !signed, 10);
}

function craft(itemid) {
    let items = [itemid];
    let buffer = new ByteBuffer(2 + 2 + (8 * items.length), ByteBuffer.LITTLE_ENDIAN);
    let recipe = null;
    
    buffer.writeInt16(recipe || -2); // -2 is wildcard
    buffer.writeInt16(items.length);
    
    for (let i = 0; i < items.length; i++) {
        buffer.writeUint64(coerceToLong(items[i]));
    }
    
    return sendGC(Language.Craft, null, buffer);
}

function sendGC(msgType, protobuf, body) {
    if (protobuf) {
        return sendToGC(STEAM_APPID, msgType, {}, protobuf.encode(body).finish());
    }
    
    // This is a ByteBuffer
    return sendToGC(STEAM_APPID, msgType, null, body.flip().toBuffer());
}

function sendToGC(appid, msgType, protoBufHeader, payload, callback) {
    let sourceJobId = 1;
    
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
        console.log('MSGtype', msgType);
        protoBufHeader.jobid_source = sourceJobId;
        let protoHeader = encodeProto(Schema.CMsgProtoBufHeader, protoBufHeader);
        header = Buffer.alloc(8);
        header.writeUInt32LE(msgType, 0); // 4
        header.writeInt32LE(protoHeader.length, 4); // 4
        console.log('Header length', protoHeader.length);
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
    
    payload = Buffer.concat([header, payload]);
    logBuffer('Header with payload', payload);
    console.log('msgtype', msgType);

    return send({
        msg: EMsg.ClientToGC,
        proto: {
            routing_appid: appid
        }
    }, {
        appid,
        msgtype: msgType,
        payload
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
        
        console.log(header.proto);
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

function fromGC(body) {
    // & - bitwise AND
    // ~ - bitwise NOT
    let msgType = body.msgtype & ~PROTO_MASK;
    let targetJobID;
    let payload;
    
    console.log('msgtype:', body.msgtype, '->', msgType);
    
    if (body.msgtype & PROTO_MASK) {
        // This is a protobuf message
        let headerLength = body.payload.readInt32LE(4);
        console.log('Has proto header:', headerLength);
        let protoHeader = SteamUserGameCoordinator._decodeProto(Schema.CMsgProtoBufHeader, body.payload.slice(8, 8 + headerLength));
        targetJobID = protoHeader.job_id_target || JOBID_NONE;
        // remove header from payload
        payload = body.payload.slice(8 + headerLength);
    } else {
        let header = ByteBuffer.wrap(body.payload.slice(0, 18));
        logBuffer('Header', header.buffer);
        targetJobID = header.readUint64(2);
        // remove header from payload
        payload = body.payload.slice(18);
    }
    
    payload =  ByteBuffer.wrap(payload, ByteBuffer.LITTLE_ENDIAN);
    
    console.log('Target job ID:', targetJobID.toString());
    receivedFromGC(body.appid, msgType, payload);
}

function receivedFromGC(appid, msgType, body) {
    console.log('Received from GC');
    console.log('appid:', appid);
    console.log('msgtype:', msgType);
    logBuffer('payload', body.buffer);
    
    if (appid !== 440) {
        return;
    } 
    
    switch (msgType) {
        case Language.CraftResponse: {
            console.log('EGCItemMsg::k_EMsgGCCraftResponse');
            let blueprint = body.readInt16(); // recipe ID
            let unknown = body.readUint32(); // always 0 in my experience
        
            let idCount = body.readUint16();
            let itemids = [];
        
            for (let i = 0; i < idCount; i++) {
                let itemid = body.readUint64().toString();
                itemids.push(itemid);
            }
            
            console.log(itemids);
        } break;
    }
}

function logBuffer(name, buffer) {
    console.log(`${name}:`, Uint8Array.from(buffer));
}

logBuffer('Final message', craft('11451257476'));
fromGC({
    appid: 440,
    msgtype: 1003,
    payload: new Uint8Array([
          1,   0, 255, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 255, 255, 255, 255,
        255, 255,  23,   0,   0,   0,   0,   0,
          3,   0,
        // itemids
        132, 196, 178, 170,   2,   0,   0,   0, 
        133, 196, 178, 170,   2,   0,   0,   0, 
        134, 196, 178, 170,   2,   0,   0,   0
    ]).buffer
})
