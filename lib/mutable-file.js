/* global IS_BROWSER_BUILD */
import File from './file'
import pipeline from 'stream-combiner'
import secureRandom from 'secure-random'
import through from 'through'
import { e64, getCipher, megaEncrypt, formatKey, AES } from './crypto'
import { detectSize, streamToCb } from './util'

// the metadata can be mutated, not the content

const KEY_CACHE = {}

class MutableFile extends File {
  constructor (opt, storage) {
    super(opt)

    this.storage = storage
    this.api = storage.api
    this.nodeId = opt.h
    this.timestamp = opt.ts
    this.type = opt.t
    this.directory = !!this.type

    if (opt.k) {
      const keyId = opt.k.split(':')[0]
      const key = storage.shareKeys[keyId]
      let aes = storage.aes
      if (key) {
        aes = KEY_CACHE[keyId]
        if (!aes) {
          aes = KEY_CACHE[keyId] = new AES(key)
        }
      }
      this.loadMetadata(aes, opt)
    }
  }

  loadAttributes () {
    throw Error('This is not needed for files loaded from logged in sessions')
  }

  mkdir (opt, cb) {
    if (!this.directory) throw Error("node isn't a directory")
    if (typeof opt === 'string') {
      opt = {name: opt}
    }
    if (!opt.attributes) opt.attributes = {}
    if (opt.name) opt.attributes.n = opt.name

    if (!opt.attributes.n) {
      throw Error('file name is required')
    }

    if (!opt.target) opt.target = this
    if (!opt.key) opt.key = new Buffer(secureRandom(32))

    if (opt.key.length !== 32) {
      throw Error('wrong key length, must be 256bit')
    }

    const key = opt.key
    const at = MutableFile.packAttributes(opt.attributes)

    getCipher(key).encryptCBC(at)

    const storedKey = new Buffer(key)
    this.storage.aes.encryptECB(storedKey)

    const request = {
      a: 'p',
      t: opt.target.nodeId ? opt.target.nodeId : opt.target,
      n: [{
        h: 'xxxxxxxx',
        t: 1,
        a: e64(at),
        k: e64(storedKey)
      }]
    }

    const shares = getShares(this.storage.shareKeys, this)
    if (shares.length > 0) {
      request.cr = makeCryptoRequest(this.storage, [{
        nodeId: 'xxxxxxxx',
        key
      }], shares)
    }

    this.api.request(request, (err, response) => {
      if (err) return returnError(err)
      const file = this.storage._importFile(response.f[0])
      this.storage.emit('add', file)

      if (cb) {
        cb(null, file)
      }
    })

    function returnError (e) {
      if (cb) cb(e)
    }
  }

  upload (opt, source, cb) {
    if (!this.directory) throw Error('node is not a directory')
    if (arguments.length === 2 && typeof source === 'function') {
      [cb, source] = [source, null]
    }

    if (typeof opt === 'string') {
      opt = {name: opt}
    }

    if (!opt.attributes) opt.attributes = {}
    if (opt.name) opt.attributes.n = opt.name

    if (!opt.attributes.n) {
      throw Error('File name is required.')
    }

    if (!opt.target) opt.target = this

    let key = formatKey(opt.key)
    if (!key) key = secureRandom(24)
    if (!(key instanceof Buffer)) key = new Buffer(key)
    if (key.length !== 24) {
      throw Error('Wrong key length. Key must be 192bit')
    }
    opt.key = key

    let finalKey

    const hashes = []
    const checkCallbacks = (err, type, hash, encrypter) => {
      if (err) return returnError(err)
      hashes[type] = hash
      if (type === 0) finalKey = encrypter.key

      if (opt.thumbnailImage && !hashes[1]) return
      if (opt.previewImage && !hashes[2]) return
      if (!hashes[0]) return

      const at = MutableFile.packAttributes(opt.attributes)
      getCipher(finalKey).encryptCBC(at)

      const storedKey = new Buffer(finalKey)
      this.storage.aes.encryptECB(storedKey)

      const fileObject = {
        h: hashes[0].toString(),
        t: 0,
        a: e64(at),
        k: e64(storedKey)
      }

      if (hashes.length !== 1) {
        fileObject.fa = hashes.slice(1).map((hash, index) => {
          return index + '*' + e64(hash)
        }).filter(e => e).join('/')
      }

      const request = {
        a: 'p',
        t: opt.target.nodeId ? opt.target.nodeId : opt.target,
        n: [fileObject]
      }

      const shares = getShares(this.storage.shareKeys, this)
      if (shares.length > 0) {
        request.cr = makeCryptoRequest(this.storage, [{
          nodeId: fileObject.h,
          key: finalKey
        }], shares)
      }

      this.api.request(request, (err, response) => {
        if (err) return returnError(err)
        const file = this.storage._importFile(response.f[0])
        this.storage.emit('add', file)
        stream.emit('complete', file)

        if (cb) cb(null, file)
      })
    }

    if (opt.thumbnailImage) {
      this._uploadAttribute(opt, opt.thumbnailImage, 1, checkCallbacks)
    }
    if (opt.previewImage) {
      this._uploadAttribute(opt, opt.previewImage, 2, checkCallbacks)
    }

    const stream = this._upload(opt, source, 0, checkCallbacks)

    const returnError = (e) => {
      if (cb) {
        cb(e)
      } else {
        stream.emit('error', e)
      }
    }

    return stream
  }

  _upload (opt, source, type, cb) {
    const encrypter = megaEncrypt(opt.key)
    const pause = through().pause()
    let stream = pipeline(pause, encrypter)

    // Size is needed before upload. Kills the streaming otherwise.
    let size = opt.size

    // handle buffer
    if (source && typeof source.pipe !== 'function') {
      size = source.length
      stream.write(source)
      stream.end()
    }

    if (size) {
      this._uploadWithSize(stream, size, encrypter, pause, type, null, cb)
    } else {
      stream = pipeline(detectSize((size) => {
        this._uploadWithSize(stream, size, encrypter, pause, type, null, cb)
      }), stream)
    }

    // handle stream
    if (source && typeof source.pipe === 'function') {
      source.pipe(stream)
    }

    return stream
  }

  _uploadAttribute (opt, source, type, cb) {
    const gotBuffer = (err, buffer) => {
      if (err) return cb(err)

      const len = buffer.length
      const rest = Math.ceil(len / 16) * 16 - len

      if (rest !== 0) {
        buffer = Buffer.concat([buffer, Buffer.alloc(rest)])
      }

      const encrypter = opt.handle
      ? getCipher(opt.key)
      : new AES(opt.key.slice(0, 16))
      encrypter.encryptCBC(buffer)

      const pause = through().pause()
      let stream = pipeline(pause)
      stream.write(buffer)
      stream.end()

      this._uploadWithSize(stream, buffer.length, stream, pause, type, opt.handle, cb)
    }

    // handle buffer
    if (source instanceof Buffer) {
      gotBuffer(null, source)
      return
    }

    streamToCb(source, gotBuffer)
  }

  _uploadWithSize (stream, size, source, pause, type, handle, cb) {
    const ssl = IS_BROWSER_BUILD ? 2 : 0
    const request = type === 0
    ? {a: 'u', ssl, s: size, ms: '-1', r: 0, e: 0}
    : {a: 'ufa', ssl, s: size}

    if (handle) {
      request.h = handle
    }

    this.api.request(request, (err, resp) => {
      if (err) return cb(err)

      const httpreq = this.api.requestModule({
        uri: resp.p + (type === 0 ? '' : '/' + (type - 1)),
        headers: {'Content-Length': size},
        method: 'POST'
      })

      streamToCb(httpreq, (err, hash) => {
        cb(err, type, hash, source)
      })

      let sizeCheck = 0
      source.on('data', d => {
        sizeCheck += d.length
        stream.emit('progress', {bytesLoaded: sizeCheck, bytesTotal: size})
      })

      source.on('end', () => {
        if (size && sizeCheck !== size) {
          return stream.emit('error', Error('Specified data size does not match: ' + size + ' !== ' + sizeCheck))
        }
      })

      source.pipe(httpreq)
      pause.resume()
    })
  }

  uploadAttribute (type, data, callback) {
    if (typeof type === 'string') {
      type = ['thumbnail', 'preview'].indexOf(type)
    }
    if (type !== 0 && type !== 1) throw Error('Invalid attribute type')

    this._uploadAttribute({
      key: this.key,
      handle: this.nodeId
    }, data, type + 1, (err, streamType, hash, encrypter) => {
      if (err) return callback(err)
      const request = {
        a: 'pfa',
        n: this.nodeId,
        fa: type + '*' + e64(hash)
      }

      this.api.request(request, (err, response) => {
        if (err) return callback(err)
        callback(null, this)
      })
    })
  }

  delete (permanent, cb) {
    if (typeof permanent === 'function') {
      cb = permanent
      permanent = undefined
    }

    if (typeof permanent === 'undefined') {
      permanent = this.parent === this.storage.trash
    }

    if (permanent) {
      this.api.request({a: 'd', n: this.nodeId}, cb)
    } else {
      this.moveTo(this.storage.trash, cb)
    }

    return this
  }

  moveTo (target, cb) {
    if (typeof target === 'string') {
      target = this.storage.files[target]
    }

    if (!(target instanceof File)) {
      throw Error('target must be a folder or a nodeId')
    }

    const request = {a: 'm', n: this.nodeId, t: target.nodeId}
    const shares = getShares(this.storage.shareKeys, target)
    if (shares.length > 0) {
      request.cr = makeCryptoRequest(this.storage, [this], shares)
    }

    this.api.request(request, cb)

    return this
  }

  setAttributes (attributes, cb) {
    Object.assign(this.attributes, attributes)

    const newAttributes = MutableFile.packAttributes(this.attributes)
    getCipher(this.key).encryptCBC(newAttributes)

    this.api.request({a: 'a', n: this.nodeId, at: e64(newAttributes)}, () => {
      this.parseAttributes(this.attributes)
      if (cb) cb()
    })

    return this
  }

  rename (filename, cb) {
    this.setAttributes({
      n: filename
    }, cb)

    return this
  }

  setLabel (label, cb) {
    if (typeof label === 'string') label = File.LABEL_NAMES.indexOf(label)
    if (typeof label !== 'number' || Math.floor(label) !== label || label < 0 || label > 7) {
      throw Error('label must be a integer between 0 and 7 or a valid label name')
    }

    this.setAttributes({
      lbl: label
    }, cb)

    return this
  }

  setFavorite (isFavorite, cb) {
    this.setAttributes({
      fav: isFavorite ? 1 : 0
    }, cb)

    return this
  }

  link (options, cb) {
    if (arguments.length === 1 && typeof options === 'function') {
      cb = options
      options = {
        noKey: false
      }
    }

    if (typeof options === 'boolean') {
      options = {
        noKey: options
      }
    }

    // __folderKey is used internally, don't use this
    const folderKey = options.__folderKey
    if (this.directory && !folderKey) {
      this.shareFolder(options, cb)
      return this
    }

    this.api.request({a: 'l', n: this.nodeId}, (err, id) => {
      if (err) return cb(err)

      let url = `https://mega.nz/#${folderKey ? 'F' : ''}!${id}`
      if (!options.noKey && this.key) url += `!${e64(folderKey || this.key)}`

      cb(null, url)
    })

    return this
  }

  shareFolder (options, cb) {
    if (!this.directory) throw Error("node isn't a folder")

    const handler = this.nodeId
    const storedShareKey = this.storage.shareKeys[handler]
    if (storedShareKey) {
      this.link(Object.assign({
        __folderKey: storedShareKey
      }, options), cb)

      return this
    }

    let shareKey = formatKey(options.key)

    if (!shareKey) {
      shareKey = secureRandom(16)
    }

    if (!(shareKey instanceof Buffer)) {
      shareKey = new Buffer(shareKey)
    }

    if (shareKey.length !== 16) {
      process.nextTick(() => {
        cb(Error('share key must be 16 byte / 22 characters'))
      })
      return
    }

    this.storage.shareKeys[handler] = shareKey

    const authKey = new Buffer(handler + handler)
    this.storage.aes.encryptECB(authKey)

    const request = {
      a: 's2',
      n: handler,
      s: [{u: 'EXP', r: 0}],
      ok: e64(this.storage.aes.encryptECB(new Buffer(shareKey))),
      ha: e64(authKey),
      cr: makeCryptoRequest(this.storage, this)
    }

    this.api.request(request, () => {
      this.link(Object.assign({
        __folderKey: shareKey
      }, options), cb)
    })

    return this
  }

  unshareFolder (options, cb) {
    const request = {
      a: 's2',
      n: this.nodeId,
      s: [{u: 'EXP', r: ''}]
    }

    delete this.storage.shareKeys[this.nodeId]

    this.api.request(request, () => {
      if (cb) cb()
    })

    return this
  }
}

MutableFile.packAttributes = (attributes) => {
  let at = JSON.stringify(attributes)
  at = new Buffer(`MEGA${at}`)
  const ret = Buffer.alloc(Math.ceil(at.length / 16) * 16)
  at.copy(ret)
  return ret
}

// source: https://github.com/meganz/webclient/blob/918222d5e4521c8777b1c8da528f79e0110c1798/js/crypto.js#L3728
// generate crypto request response for the given nodes/shares matrix
function makeCryptoRequest (storage, sources, shares) {
  const shareKeys = storage.shareKeys

  if (!Array.isArray(sources)) {
    sources = selfAndChildren(sources)
  }

  if (!shares) {
    shares = sources
    .map(source => getShares(shareKeys, source))
    .reduce((arr, el) => arr.concat(el))
    .filter((el, index, arr) => index === arr.indexOf(el))
  }

  const cryptoRequest = [
    shares,
    sources.map(node => node.nodeId),
    []
  ]

  // TODO: optimize - keep track of pre-existing/sent keys, only send new ones
  for (let i = shares.length; i--;) {
    const aes = new AES(shareKeys[shares[i]])

    for (let j = sources.length; j--;) {
      const fileKey = new Buffer(sources[j].key)

      if (fileKey && (fileKey.length === 32 || fileKey.length === 16)) {
        cryptoRequest[2].push(i, j, e64(aes.encryptECB(fileKey)))
      }
    }
  }

  return cryptoRequest
}

function selfAndChildren (node) {
  return [node]
  .concat((node.children || [])
  .map(selfAndChildren)
  .reduce((arr, el) => arr.concat(el), []))
}

function getShares (shareKeys, node) {
  const handle = node.nodeId
  const parent = node.parent
  const shares = []

  if (shareKeys[handle]) {
    shares.push(handle)
  }

  return parent
  ? shares.concat(getShares(shareKeys, parent))
  : shares
}

export default MutableFile
