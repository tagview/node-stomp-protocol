import { StompFrame, StompEventEmitter, StompError, StompConfig } from "./model";
import { StompStreamLayer } from "./stream";
import { EventEmitter } from "events";


enum StompFrameStatus {
    COMMAND = 0,
    HEADERS = 1,
    BODY = 2,
    ERROR = 3
}

export type StompFrameEvent = 'frame' | 'error' | 'end';

export class StompFrameLayer {

    public readonly emitter = new StompEventEmitter<StompFrameEvent>();
    public maxBufferSize = 10 * 1024;
    private frame: StompFrame;
    private contentLength: number;
    private buffer = Buffer.alloc(0);
    private status = StompFrameStatus.COMMAND;
    private newlineCounter = 0;
    private connectTimeout?: NodeJS.Timer;
    public headerFilter = (headerName: string) => true;

    constructor(private readonly stream: StompStreamLayer, options?: StompConfig) {
        stream.emitter.on('data', (data: Buffer) => this.onData(data));
        stream.emitter.on('end', () => this.onEnd());
        this.init(options);
    }

    private init(options?: StompConfig) {
        if (options) {
            if (options.connectTimeout && options.connectTimeout > 0) {
                this.connectTimeout = setTimeout(() => this.stream.close(), options.connectTimeout);
            }
        }
    }

    /**
     * Transmit a frame using the underlying stream layer.
     */
    public async send(frame: StompFrame) {
        let data = frame.command + '\n';
        let headers = Object.keys(frame.headers).filter(this.headerFilter).sort();
        for (var key of headers) {
            data += key + ':' + frame.headers[key] + '\n';
        }
        if (frame.body.length > 0) {
            if (!frame.headers.hasOwnProperty('suppress-content-length')) {
                data += 'content-length:' + Buffer.byteLength(frame.body) + '\n';
            }
        }
        data += '\n';
        if (frame.body.length > 0) {
            data += frame.body;
        }
        data += '\0';

        await this.stream.send(data);
    }

    /**
     * Closes the underlying stream layer.
     */
    public async close() {
        await this.stream.close();
    }

    /**
     * Main entry point for frame parsing. It's a state machine that expects
     * the standard [ command - headers - body ] structure of a frame.
     */
    private onData(data: Buffer) {
        this.buffer = Buffer.concat([this.buffer, data]);
        if (this.buffer.length <= this.maxBufferSize) {
            do {
                if (this.status === StompFrameStatus.COMMAND) {
                    this.parseCommand();
                }
                if (this.status === StompFrameStatus.HEADERS) {
                    this.parseHeaders();
                }
                if (this.status === StompFrameStatus.BODY) {
                    this.parseBody();
                }
                if (this.status === StompFrameStatus.ERROR) {
                    this.parseError();
                }
                // still waiting for command line, there is other data remaining
            } while (this.status === StompFrameStatus.COMMAND && this.hasLine());
        } else {
            this.error(new StompError('Maximum buffer size exceeded.'));
            this.stream.close();
        }
    }

    private onEnd() {
        this.emitter.emit('end');
    }

    private parseCommand() {
        while (this.hasLine()) {
            var commandLine = this.popLine();
            // command length security check: should be in 1 - 30 char range.
            if (commandLine.length > 0 && commandLine.length < 30) {
                this.frame = new StompFrame(commandLine.toString().replace('\r', ''));
                this.contentLength = -1;
                this.incrementStatus();
                break;
            }
        }
    }

    /**
     * Parse and checks frame headers format. When content-length header is
     * detected, it can be used by the body parser.
     */
    private parseHeaders() {
        var value;
        while (this.hasLine()) {
            var headerLine = this.popLine();
            if (headerLine.length === 0) {
                this.incrementStatus();
                break;
            } else {
                var kv = headerLine.toString().replace('\r', '').split(':');
                if (kv.length < 2) {
                    this.error(new StompError('Error parsing header', `No ':' in line '${headerLine}'`));
                    break;
                }
                value = kv.slice(1).join(':');
                this.frame.setHeader(kv[0], value);
                if (kv[0] === 'content-length') {
                    this.contentLength = parseInt(value);
                }
            }
        }
    }

    /**
     * Parse frame body, using both the content-length header and null char to
     * determine the frame end.
     */
    private parseBody() {
        var bufferBuffer = new Buffer(this.buffer);

        if (this.contentLength > -1) {
            // consume data using content-length header
            const remainingLength = this.contentLength - this.frame.body.length;
            if (remainingLength <= bufferBuffer.length) {
                this.frame.appendToBody(bufferBuffer.slice(0, remainingLength));
                this.buffer = bufferBuffer.slice(remainingLength, bufferBuffer.length);
                if (this.buffer.indexOf('\0') === 0) this.buffer = Buffer.alloc(0);
                this.contentLength = -1;
                this.emitFrame();
            }

        } else {
            // consume data using the null-char end
            const index = this.buffer.indexOf('\0');
            if (index == -1) {
                this.frame.appendToBody(this.buffer);
                this.buffer = Buffer.alloc(0);
            } else {
                // The end of the frame has been identified, finish creating it
                this.frame.appendToBody(this.buffer.slice(0, index));
                this.buffer = this.buffer.slice(index + 1);
                this.emitFrame();
            }
        }
    }

    private emitFrame() {
        // Emit the frame and reset
        this.emitter.emit('frame', this.frame); // Event emit to catch any frame emission

        if (this.connectTimeout) { // first frame received. Cancel disconnect timeout
            clearTimeout(this.connectTimeout);
            delete this.connectTimeout;
        }

        this.incrementStatus();
    }

    /**
     * Parses the error
     */
    private parseError() {
        var index = this.buffer.indexOf('\0');
        if (index > -1) {
            // End of the frame is already in buffer
            this.buffer = this.buffer.slice(index + 1);
            this.incrementStatus();
        } else {
            // End of the frame not seen yet
            this.buffer = Buffer.alloc(0);
        }
    }

    /**
     * Pops a new line from the stream
     * @return {string} the new line available
     */
    private popLine() {
        if (this.newlineCounter++ > 100) { //security check for newline char flooding
            this.stream.close();
            throw new Error('Newline flooding detected.');
        }
        var index = this.buffer.indexOf('\n');
        var line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        return line;
    }

    /**
     * Check if there is a new line in the current stream chunk
     * @return {boolean}
     */
    private hasLine() {
        return (this.buffer.indexOf('\n') > -1);
    }

    /**
     * Emits a new StompFrameError and sets the current status to ERROR
     * @param  {StompFrameError} error
     */
    private error(error: StompError) {
        this.emitter.emit('error', error);
        this.status = StompFrameStatus.ERROR;
    }

    /**
     * Set the current status to the next available, otherwise it returns in COMMAND status.
     */
    private incrementStatus() {
        if (this.status === StompFrameStatus.BODY || this.status === StompFrameStatus.ERROR) {
            this.status = StompFrameStatus.COMMAND;
            this.newlineCounter = 0;
        } else {
            this.status++;
        }
    }

}
