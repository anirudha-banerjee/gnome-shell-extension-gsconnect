'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Packet
 *
 * The packet class is a simple Object-derived class. It only exists to offer
 * conveniences for coercing to a string writable to a channel and constructing
 * from Strings and Objects. In future, it could probably be optimized to avoid
 * excessive shape-trees since it's the most common object in the protocol.
 */
var Packet = class Packet {

    constructor(data = null) {
        this.id = 0;
        this.type = undefined;
        this.body = {};

        if (data === null) {
            return;
        } else if (typeof data === 'string') {
            this.fromString(data);
        } else {
            this.fromObject(data);
        }
    }

    /**
     * Update the packet from a string of JSON
     *
     * @param {string} data - A string of text
     */
    fromString(data) {
        try {
            let json = JSON.parse(data);
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
        }
    }

    /**
     * Update the packet from an Object, using and intermediate call to
     * JSON.stringify() to deep-copy the object, avoiding reference entanglement
     *
     * @param {string} data - An object
     */
    fromObject(data) {
        try {
            let json = JSON.parse(JSON.stringify(data));
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
        }
    }

    [Symbol.toPrimitive](hint) {
        this.id = Date.now();

        switch (hint) {
            case 'string':
                return `${JSON.stringify(this)}\n`;
            case 'number':
                return `${JSON.stringify(this)}\n`.length;
            default:
                return true;
        }
    }

    toString() {
        return `${this}`;
    }
};


/**
 * Data Channel
 */
var Channel = class Channel {

    constructor(params) {
        Object.assign(this, params);
    }

    get cancellable() {
        if (this._cancellable === undefined) {
            this._cancellable = new Gio.Cancellable();
        }

        return this._cancellable;
    }

    get service() {
        return Gio.Application.get_default();
    }

    get type() {
        return null;
    }

    get uuid() {
        if (this._uuid === undefined) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    }

    set uuid(uuid) {
        this._uuid = uuid;
    }

    /**
     * Override this in subclasses to configure any necessary socket options.
     * The defau;t implementation returns the original Gio.SocketConnection.
     */
    _initSocket(connection) {
        return connection;
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            debug('receiving identity');

            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        let data = stream.read_line_finish_utf8(res)[0];
                        stream.close(null);

                        // Store the identity as an object property
                        this.identity = new Packet(data);

                        // Reject connections without a deviceId
                        if (!this.identity.body.deviceId) {
                            throw new Error('missing deviceId');
                        }

                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            debug('sending identity');

            connection.output_stream.write_all_async(
                `${this.service.identity}`,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Override these in subclasses to negotiate encryption. The default
     * implementations simply return the original Gio.SocketConnection.
     */
    _clientEncryption(connection) {
        return Promise.resolve(connection);
    }

    _serverEncryption(connection) {
        return Promise.resolve(connection);
    }

    /**
     * Attach to @device as the default channel used for packet exchange. This
     * should connect the channel's Gio.Cancellable to mark the device as
     * disconnected, setup the IO streams, start the receive() loop and set the
     * device as connected.
     *
     * @param {Device.Device} device - The device to attach to
     */
    attach(device) {
        // Detach any existing channel
        if (device._channel && device._channel !== this) {
            device._channel.cancellable.disconnect(device._channel._id);
            device._channel.close();
        }

        // Attach the new channel and parse it's identity
        device._channel = this;
        this._id = this.cancellable.connect(device._setDisconnected.bind(device));
        device._handleIdentity(this.identity);

        // Setup streams for packet exchange
        this.input_stream = new Gio.DataInputStream({
            base_stream: this._connection.input_stream
        });

        this.output_queue = [];
        this.output_stream = this._connection.output_stream;

        // Start listening for packets
        this.receive(device);

        // Emit connected:: if necessary
        if (!device.connected) {
            device._setConnected();
        }
    }

    /**
     * Open an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     * @return {Boolean} - %true on connected, %false otherwise
     */
    async open(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Accept an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        debug(`${this.constructor.name} (${this.type})`);

        // Cancel any queued operations
        this.cancellable.cancel();

        // Close any streams
        [this._connection, this.input_stream, this.output_stream].map(stream => {
            try {
                stream.close(null);
            } catch (e) {
                // Silence errors
            }
        });
    }

    /**
     * Receive a packet from the channel and call receivePacket() on the device
     *
     * @param {Device.Device} device - The device which will handle the packet
     */
    receive(device) {
        this.input_stream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this.cancellable,
            (stream, res) => {
                let data, packet;

                try {
                    // Try to read and parse a packet
                    data = stream.read_line_finish_utf8(res)[0];

                    // Queue another receive() before handling the packet
                    this.receive(device);

                    // In case %null is returned we don't want an error thrown
                    // when trying to parse it as a packet
                    if (data !== null) {
                        packet = new Packet(data);
                        debug(packet, this.identity.body.deviceName);
                        device.receivePacket(packet);
                    }
                } catch (e) {
                    debug(e, this.identity.body.deviceName);
                    this.close();
                }
            }
        );
    }

    /**
     * Send a packet to a device
     *
     * @param {object} packet - An dictionary of packet data
     */
    async send(packet) {
        let next;

        try {
            this.output_queue.push(new Packet(packet));

            if (!this.__lock) {
                this.__lock = true;

                while ((next = this.output_queue.shift())) {
                    await new Promise((resolve, reject) => {
                        this.output_stream.write_all_async(
                            next.toString(),
                            GLib.PRIORITY_DEFAULT,
                            this.cancellable,
                            (stream, res) => {
                                try {
                                    resolve(stream.write_all_finish(res));
                                } catch (e) {
                                    reject(e);
                                }
                            }
                        );
                    });

                    debug(next, this.identity.body.deviceName);
                }

                this.__lock = false;
            }
        } catch (e) {
            debug(e, this.identity.body.deviceName);
            this.close();
        }
    }

    /**
     * Override these in subclasses to negotiate payload transfers. Both methods
     * should cleanup after themselves and return a success boolean.
     *
     * The default implementation will always report failure, for protocols that
     * won't or don't yet support payload transfers.
     */
    async download(packet) {
        let result = false;

        try {
            throw new GObject.NotImplementedError();
        } catch (e) {
            debug(e, this.identity.body.deviceName);
        } finally {
            this.close();
        }

        return result;
    }

    async upload(port) {
        let result = false;

        try {
            throw new GObject.NotImplementedError();
        } catch (e) {
            debug(e, this.identity.body.deviceName);
        } finally {
            this.close();
        }

        return result;
    }

    /**
     * Transfer using g_output_stream_splice()
     *
     * @return {Boolean} - %true on success, %false on failure.
     */
    async _transfer() {
        let result = false;

        try {
            result = await new Promise((resolve, reject) => {
                this.output_stream.splice_async(
                    this.input_stream,
                    Gio.OutputStreamSpliceFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    this.cancellable,
                    (source, res) => {
                        try {
                            if (source.splice_finish(res) < this.size) {
                                throw new Error('incomplete data');
                            }

                            resolve(true);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            debug(e, this.identity.body.deviceName);
        } finally {
            this.close();
        }

        return result;
    }
};


/**
 * File Transfer base class
 */
var Transfer = class Transfer extends Channel {

    /**
     * @param {object} params - Transfer parameters
     * @param {Device.Device} params.device - The device that owns this transfer
     * @param {Gio.InputStream} params.input_stream - The input stream (read)
     * @param {Gio.OutputStrea} params.output_stream - The output stream (write)
     * @param {number} params.size - The size of the transfer in bytes
     */
    constructor(params) {
        super(params);
        this.device._transfers.set(this.uuid, this);
    }

    get identity() {
        return this.device._channel.identity;
    }

    get type() {
        return 'transfer';
    }

    close() {
        this.device._transfers.delete(this.uuid);
        super.close();
    }
};

