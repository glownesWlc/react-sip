import * as JsSIP from 'jssip';
import {
  AnswerOptions,
  HoldEvent,
  RenegotiateOptions,
  RTCSession,
  TerminateOptions,
} from 'jssip/lib/RTCSession';
import { IncomingRequest, OutgoingRequest } from 'jssip/lib/SIPMessage';
import { CallOptions, UnRegisterOptions } from 'jssip/lib/UA';
import * as PropTypes from 'prop-types';
import * as React from 'react';
import dummyLogger from '../../lib/dummyLogger';
import {
  CALL_DIRECTION_INCOMING,
  CALL_DIRECTION_OUTGOING,
  CALL_STATUS_ACTIVE,
  CALL_STATUS_IDLE,
  CALL_STATUS_STARTING,
  CALL_STATUS_STOPPING,
  CallDirection,
  CallStatus,
  SIP_ERROR_TYPE_CONFIGURATION,
  SIP_ERROR_TYPE_CONNECTION,
  SIP_ERROR_TYPE_REGISTRATION,
  SIP_STATUS_CONNECTED,
  SIP_STATUS_CONNECTING,
  SIP_STATUS_DISCONNECTED,
  SIP_STATUS_ERROR,
  SIP_STATUS_REGISTERED,
  SipErrorType,
  SipStatus,
} from '../../lib/enums';
import { mediaDeviceExists } from '../../lib/media';
import {
  callPropType,
  ExtraHeaders,
  extraHeadersPropType,
  iceServersPropType,
  Logger,
  sipPropType,
  WebAudioHTMLMediaElement,
} from '../../lib/types';

export interface JsSipConfig {
  host: string;
  port: number;
  pathname: string;
  secure: boolean;
  user: string;
  password: string;
  autoRegister: boolean;
  autoAnswer: boolean;
  iceRestart: boolean;
  sessionTimersExpires: number;
  extraHeaders: ExtraHeaders;
  iceServers: RTCIceServer[];
  debug: boolean;
  inboundAudioDeviceId: string;
  outboundAudioDeviceId: string;
  debugNamespaces?: string | null;
}

export interface JsSipState {
  sipStatus: SipStatus;
  sipErrorType: SipErrorType | null;
  sipErrorMessage: string | null;
  callStatus: CallStatus;
  callDirection: CallDirection | null;
  callCounterpart: string | null;
  dtmfSender: RTCDTMFSender | null;
  callIsOnHold: boolean;
  callMicrophoneIsMuted: boolean;
  rtcSession: RTCSession | null;
}

export default class SipProvider extends React.Component<JsSipConfig, JsSipState> {
  static childContextTypes = {
    sip: sipPropType,
    call: callPropType,
    registerSip: PropTypes.func,
    unregisterSip: PropTypes.func,

    answerCall: PropTypes.func,
    startCall: PropTypes.func,
    stopCall: PropTypes.func,
    sendDTMF: PropTypes.func,
    audioSinkId: PropTypes.string,
    setAudioSinkId: PropTypes.func,
  };

  static propTypes = {
    host: PropTypes.string,
    port: PropTypes.number,
    pathname: PropTypes.string,
    secure: PropTypes.bool,
    user: PropTypes.string,
    password: PropTypes.string,
    autoRegister: PropTypes.bool,
    autoAnswer: PropTypes.bool,
    iceRestart: PropTypes.bool,
    sessionTimersExpires: PropTypes.number,
    extraHeaders: extraHeadersPropType,
    iceServers: iceServersPropType,
    debug: PropTypes.bool,
    inboundAudioDeviceId: PropTypes.string,
    outboundAudioDeviceId: PropTypes.string,

    children: PropTypes.node,
  };

  static defaultProps = {
    host: null,
    port: null,
    pathname: '',
    secure: true,
    user: null,
    password: null,
    autoRegister: true,
    autoAnswer: false,
    iceRestart: false,
    sessionTimersExpires: 120,
    extraHeaders: { register: [], invite: [], hold: [] },
    iceServers: [],
    debug: false,
    inboundAudioDeviceId: '',
    outboundAudioDeviceId: '',

    children: null,
  };
  private ua: JsSIP.UA | null = null;
  private remoteAudio: WebAudioHTMLMediaElement | null = null;
  private logger: Logger;
  private currentSinkId: string | null = null;
  // @ts-ignore
  private isPlaying = false;

  constructor(props) {
    super(props);

    this.state = {
      sipStatus: SIP_STATUS_DISCONNECTED,
      sipErrorType: null,
      sipErrorMessage: null,

      rtcSession: null,

      callStatus: CALL_STATUS_IDLE,
      callDirection: null,
      callCounterpart: null,
      dtmfSender: null,
      callIsOnHold: false,
      callMicrophoneIsMuted: false,
    };

    this.ua = null;
  }

  getChildContext() {
    return {
      sip: {
        ...this.props,
        status: this.state.sipStatus,
        errorType: this.state.sipErrorType,
        errorMessage: this.state.sipErrorMessage,
      },
      call: {
        id: 'UNKNOWN',
        status: this.state.callStatus,
        direction: this.state.callDirection,
        counterpart: this.state.callCounterpart,
        dtmfSender: this.state.dtmfSender,
        isOnHold: this.state.callIsOnHold,
        hold: this.callHold,
        unhold: this.callUnhold,
        toggleHold: this.callToggleHold,
        microphoneIsMuted: this.state.callMicrophoneIsMuted,
        muteMicrophone: this.callMuteMicrophone,
        unmuteMicrophone: this.callUnmuteMicrophone,
        toggleMuteMicrophone: this.callToggleMuteMicrophone,
        renegotiate: this.renegotiate,
      },
      registerSip: this.registerSip,
      unregisterSip: this.unregisterSip,
      audioSinkId: this.audioSinkId,
      setAudioSinkId: this.setAudioSinkId,
      answerCall: this.answerCall,
      startCall: this.startCall,
      stopCall: this.stopCall,
      sendDTMF: this.sendDTMF,
    };
  }

  /**
   * Get the underlying UserAgent from JsSIP
   */
  getUA(): JsSIP.UA | null {
    return this.ua;
  }

  getUAOrFail(): JsSIP.UA {
    const ua = this.getUA();

    if (!ua) {
      throw new Error('JsSIP.UA not initialized');
    }

    return ua;
  }

  getAudioElement(): HTMLAudioElement | null {
    return this.remoteAudio;
  }

  componentDidMount(): void {
    if (window.document.getElementById('sip-provider-audio')) {
      throw new Error(
        `Creating two SipProviders in one application is forbidden. If that's not the case ` +
        `then check if you're using "sip-provider-audio" as id attribute for any existing ` +
        `element`,
      );
    }

    this.remoteAudio = this.createRemoteAudioElement();
    window.document.body.appendChild(this.remoteAudio);

    this.reconfigureDebug();
    this.reinitializeJsSIP();
  }

  componentDidUpdate(prevProps): void {
    if (this.props.debug !== prevProps.debug) {
      this.reconfigureDebug();
    }
    if (
      this.props.host !== prevProps.host ||
      this.props.port !== prevProps.port ||
      this.props.pathname !== prevProps.pathname ||
      this.props.secure !== prevProps.secure ||
      this.props.user !== prevProps.user ||
      this.props.password !== prevProps.password ||
      this.props.autoRegister !== prevProps.autoRegister ||
      this.props.inboundAudioDeviceId !== prevProps.inboundAudioDeviceId ||
      this.props.outboundAudioDeviceId !== prevProps.outboundAudioDeviceId
    ) {
      this.reinitializeJsSIP();
    }
  }

  componentWillUnmount(): void {
    this.deleteRemoteAudio();
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }
  }

  deleteRemoteAudio(): void {
    let element: WebAudioHTMLMediaElement;

    try {
      element = this.getRemoteAudioOrFail();
    } catch (e) {
      return;
    }

    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }

    this.remoteAudio = null;
  }

  registerSip(): void {
    if (!this.ua) {
      throw new Error('Calling registerSip is not allowed when JsSIP.UA isn\'t initialized');
    }
    if (this.props.autoRegister) {
      throw new Error('Calling registerSip is not allowed when autoRegister === true');
    }
    if (this.state.sipStatus !== SIP_STATUS_CONNECTED) {
      throw new Error(
        `Calling registerSip is not allowed when sip status is ${this.state.sipStatus} (expected ${SIP_STATUS_CONNECTED})`,
      );
    }
    this.ua.register();
  }

  unregisterSip(options?: UnRegisterOptions): void {
    if (!this.ua) {
      throw new Error('Calling unregisterSip is not allowed when JsSIP.UA isn\'t initialized');
    }
    if (this.props.autoRegister) {
      throw new Error('Calling registerSip is not allowed when autoRegister === true');
    }
    if (this.state.sipStatus !== SIP_STATUS_REGISTERED) {
      throw new Error(
        `Calling unregisterSip is not allowed when sip status is ${this.state.sipStatus} (expected ${SIP_STATUS_CONNECTED})`,
      );
    }
    this.ua.unregister(options);
  }

  answerCall = (options?: AnswerOptions): void => {
    const opts = {
      mediaConstraints: {
        audio: true,
        video: false,
      },
      pcConfig: {
        iceServers: this.props.iceServers,
      },
    };

    Object.assign(opts, options);

    if (this.state.callStatus !== CALL_STATUS_STARTING || this.state.callDirection !== CALL_DIRECTION_INCOMING) {
      throw new Error(
        `Calling answerCall() is not allowed when call status is ${this.state.callStatus} and call direction is ${this.state.callDirection}  (expected ${CALL_STATUS_STARTING} and ${CALL_DIRECTION_INCOMING})`,
      );
    }

    if (!this.state.rtcSession) {
      throw new Error('State does not have an active session.');
    }

    this.state.rtcSession.answer(opts);
  };

  startCall = (destination: string | number, anonymous?: boolean): void => {
    if (!destination) {
      throw new Error(`Destination must be defined (${destination} given)`);
    }
    if (!this.ua) {
      throw new Error('Calling startCall is not allowed when JsSIP.UA isn\'t initialized');
    }
    if (this.state.sipStatus !== SIP_STATUS_CONNECTED && this.state.sipStatus !== SIP_STATUS_REGISTERED) {
      throw new Error(
        `Calling startCall() is not allowed when sip status is ${this.state.sipStatus} (expected ${SIP_STATUS_CONNECTED} or ${SIP_STATUS_REGISTERED})`,
      );
    }

    if (this.state.callStatus !== CALL_STATUS_IDLE) {
      throw new Error(
        `Calling startCall() is not allowed when call status is ${this.state.callStatus} (expected ${CALL_STATUS_IDLE})`,
      );
    }

    if (!anonymous) {
      anonymous = false;
    }

    const { iceServers, sessionTimersExpires } = this.props;
    const extraHeaders = this.props.extraHeaders.invite;

    const options: CallOptions = {
      extraHeaders,
      mediaConstraints: { audio: true, video: false },
      rtcOfferConstraints: { iceRestart: this.props.iceRestart },
      pcConfig: {
        iceServers,
      },
      sessionTimersExpires,
      anonymous,
    };

    this.ua.call(String(destination), options);
    this.setState({ callStatus: CALL_STATUS_STARTING });
  };

  stopCall = (options?: TerminateOptions) => {
    if (!this.ua) {
      throw new Error('Calling stopCall is not allowed when JsSIP.UA isn\'t initialized');
    }
    this.setState({ callStatus: CALL_STATUS_STOPPING });
    this.ua.terminateSessions(options);
  };

  sendDTMF = (tones: string, duration: number = 100, interToneGap: number = 70) => {
    if (this.state.callStatus === 'callStatus/ACTIVE' && this.state.dtmfSender) {
      this.state.dtmfSender.insertDTMF(tones, duration, interToneGap);
    } else {
      this.logger.debug('Warning:', 'You are attempting to send DTMF, but there is no active call.');
    }
  };

  reconfigureDebug(): void {
    const { debug } = this.props;

    if (debug) {
      JsSIP.debug.enable(this.props.debugNamespaces || 'JsSIP:*');
      this.logger = console;
    } else {
      JsSIP.debug.disable();
      this.logger = dummyLogger;
    }
  }

  setAudioSinkId = async (sinkId: string): Promise<void> => {
    if (this.currentSinkId && sinkId === this.currentSinkId) {
      return;
    }

    this.currentSinkId = sinkId;

    return this.getRemoteAudioOrFail().setSinkId(sinkId);
  };

  get audioSinkId(): string {
    return this.remoteAudio?.sinkId || 'undefined';
  }

  async reinitializeJsSIP(): Promise<void> {
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }

    const {
      host,
      port,
      pathname,
      secure,
      user,
      password,
      autoRegister,
      inboundAudioDeviceId,
      outboundAudioDeviceId,
    } = this.props;

    if (!host || !port || !user) {
      this.setState({
        sipStatus: SIP_STATUS_DISCONNECTED,
        sipErrorType: null,
        sipErrorMessage: null,
      });
      return;
    }

    let outputDeviceId = outboundAudioDeviceId;
    const exists = await mediaDeviceExists(outputDeviceId, 'audiooutput');
    if (!outputDeviceId || !exists) {
      outputDeviceId = 'default';
    }

    if (outputDeviceId) {
      try {
        this.remoteAudio = this.createRemoteAudioElement();
        this.logger.debug(`Audio.OUTBOUND: Setting sinkId to ${outputDeviceId}`);
        await this.setAudioSinkId(outputDeviceId);
      } catch (e) {
        this.logger.error('AUDIO.OUTBOUND: Could not set sinkId', e);
      }
    }

    try {
      const socket = new JsSIP.WebSocketInterface(`${secure ? 'wss' : 'ws'}://${host}:${port}${pathname}`);
      this.ua = new JsSIP.UA({
        uri: "sip:1001@zfakon4cfv.dev.cpaaslabs.net", // change by greg
        password,
        sockets: [socket],
        register: autoRegister,
      });
      // @ts-ignore
      window.UA = this.ua;
      // @ts-ignore
      window.UA_SOCKET = socket;
    } catch (error) {
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_CONFIGURATION,
        sipErrorMessage: error.message,
      });
      return;
    }

    const { ua } = this;
    ua.on('connecting', () => {
      this.logger.debug('UA "connecting" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_CONNECTING,
        sipErrorType: null,
        sipErrorMessage: null,
      });
    });

    ua.on('connected', () => {
      this.logger.debug('UA "connected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_CONNECTED,
        sipErrorType: null,
        sipErrorMessage: null,
      });
    });

    ua.on('disconnected', () => {
      this.logger.debug('UA "disconnected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_CONNECTION,
        sipErrorMessage: 'disconnected',
      });
    });

    ua.on('registered', (data) => {
      this.logger.debug('UA "registered" event', data);
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_REGISTERED,
        callStatus: CALL_STATUS_IDLE,
      });
    });

    ua.on('unregistered', () => {
      this.logger.debug('UA "unregistered" event');
      if (this.ua !== ua) {
        return;
      }
      if (ua.isConnected()) {
        this.setState({
          sipStatus: SIP_STATUS_CONNECTED,
          callStatus: CALL_STATUS_IDLE,
          callDirection: null,
        });
      } else {
        this.setState({
          sipStatus: SIP_STATUS_DISCONNECTED,
          callStatus: CALL_STATUS_IDLE,
          callDirection: null,
        });
      }
    });

    ua.on('registrationFailed', (data) => {
      this.logger.debug('UA "registrationFailed" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_REGISTRATION,
        sipErrorMessage: data.cause || data.response.reason_phrase,
      });
    });

    ua.on('newRTCSession', ({ originator, session: rtcSession, request: rtcRequest }: { originator: 'local' | 'remote' | 'system', session: RTCSession, request: IncomingRequest | OutgoingRequest }) => {
        // @ts-ignore
        window.UA_SESSION = rtcSession;
        if (!this || this.ua !== ua) {
          return;
        }

        const { rtcSession: rtcSessionInState } = this.state;
        // Avoid if busy or other incoming
        if (rtcSessionInState) {
          this.logger.debug('incoming call replied with 486 "Busy Here"');
          rtcSession.terminate({
            status_code: 486,
            reason_phrase: 'Busy Here',
          });
          return;
        }

        // identify call direction
        if (originator === 'local') {
          const foundUri = rtcRequest.to.toString();
          const delimiterPosition = foundUri.indexOf(';') || null;
          this.setState({
            callDirection: CALL_DIRECTION_OUTGOING,
            callStatus: CALL_STATUS_STARTING,
            callCounterpart: delimiterPosition ? foundUri.substring(0, delimiterPosition) || foundUri : foundUri,
            callIsOnHold: rtcSession.isOnHold().local,
            callMicrophoneIsMuted: rtcSession.isMuted().audio || false,
          });
        } else if (originator === 'remote') {
          const foundUri = rtcRequest.from.toString();
          const delimiterPosition = foundUri.indexOf(';') || null;
          this.setState({
            callDirection: CALL_DIRECTION_INCOMING,
            callStatus: CALL_STATUS_STARTING,
            callCounterpart: delimiterPosition ? foundUri.substring(0, delimiterPosition) || foundUri : foundUri,
            callIsOnHold: rtcSession.isOnHold().local,
            callMicrophoneIsMuted: rtcSession.isMuted().audio || false,
          });
        } else {
          this.logger.warn(`call originator expected to be either local or remote. Got: ${originator}`);
        }

        this.setState({ rtcSession });


        rtcSession.on('failed', () => {
          if (this.ua !== ua) {
            return;
          }

          if (this.state.rtcSession && this.state.rtcSession.connection) {
            // Close senders, as these keep the microphone open according to browsers (and that keeps Bluetooth headphones from exiting headset mode)
            this.state.rtcSession.connection.getSenders().forEach((sender) => {
              if (sender.track) {
                sender.track.stop();
              }
            });
          }

          this.setState({
            rtcSession: null,
            callStatus: CALL_STATUS_IDLE,
            callDirection: null,
            callCounterpart: null,
            dtmfSender: null,
            callMicrophoneIsMuted: false,
          });
        });

        rtcSession.on('ended', () => {
          if (this.ua !== ua) {
            return;
          }

          if (this.state.rtcSession && this.state.rtcSession.connection) {
            // Close senders, as these keep the microphone open according to browsers
            // and keeps Bluetooth headphones from exiting headset mode
            this.state.rtcSession.connection.getSenders().forEach((sender) => {
              if (sender.track) {
                sender.track.stop();
              }
            });
          }

          this.setState({
            rtcSession: null,
            callStatus: CALL_STATUS_IDLE,
            callDirection: null,
            callCounterpart: null,
            callIsOnHold: false,
            dtmfSender: null,
            callMicrophoneIsMuted: false,
          });
        });

        rtcSession.on('unhold', (e: HoldEvent) => {
          this.logger.debug('rtcSession.unhold', e);
        });

        rtcSession.on('peerconnection', (pc) => {
          const remoteAudio = this.getRemoteAudioOrFail();
          remoteAudio.srcObject = pc.peerconnection.getRemoteStreams()[0];

          pc.peerconnection.addEventListener('addstream', (event: MediaStreamEvent) => {
            this.logger.debug('connection.addstream', event);
            const stream = event.stream;

            if (stream) {
              this.logger.debug('connection.addstream: set remoteAudio.srcObject', stream);
              remoteAudio.srcObject = stream;

              remoteAudio.play()
                .then(() => {
                  this.logger.debug('remoteAudio: playing');
                  this.isPlaying = true;
                }).catch((e) => {
                this.logger.error('remoteAudio: not playing', e);
                this.isPlaying = false;
              });
            }
          });
        });

        rtcSession.on('accepted', () => {
          if (this.ua !== ua) {
            return;
          }

          // Set input device, if provided
          if (inboundAudioDeviceId) {
            // Get the appropriate device and set the new stream
            const constraints = { audio: { deviceId: { exact: inboundAudioDeviceId } } };
            navigator.mediaDevices
              .getUserMedia(constraints)
              .then((stream) => {

                stream.getAudioTracks().forEach((track) => {
                  if (track) {
                    this.logger.debug(`AUDIO.INBOUND: Attaching track`, track);
                    rtcSession.connection.getSenders().forEach((sender) => {
                      this.logger.debug('AUDIO.INBOUND: Replacing track', { sender }, { track });
                      sender.replaceTrack(track);
                    });
                    // rtcSession.connection.addTrack(track);
                  }
                });
              })
              .catch((e) => {
                this.logger.error('AUDIO.INBOUND: Invalid audio device passed.', e);
              });
          }

          // Set up DTMF
          this.setState({
            dtmfSender: rtcSession.connection.getSenders().filter(x => x.dtmf)[0].dtmf,
          });

          this.setState({ callStatus: CALL_STATUS_ACTIVE });
        });

        this.handleAutoAnswer();
      },
    );

    const extraHeadersRegister = this.props.extraHeaders.register || [];
    if (extraHeadersRegister.length) {
      ua.registrator().setExtraHeaders(extraHeadersRegister);
    }
    ua.start();
  }

  private handleAutoAnswer() {
    if (
      this.state.callDirection === CALL_DIRECTION_INCOMING &&
      this.props.autoAnswer
    ) {
      this.logger.log('Answer auto ON');
      this.answerCall();
    } else if (
      this.state.callDirection === CALL_DIRECTION_INCOMING &&
      !this.props.autoAnswer
    ) {
      this.logger.log('Answer auto OFF');
    } else if (this.state.callDirection === CALL_DIRECTION_OUTGOING) {
      this.logger.log('OUTGOING call');
    }
  }

  render(): React.ReactNode {
    return this.props.children;
  }

  callHold = (useUpdate = false): void => {
    if (!this.state.rtcSession) {
      this.logger.warn('callHold: no-op as there\'s no active rtcSession');
      return; // no-op
    }

    const holdStatus = this.state.rtcSession.isOnHold();
    if (!holdStatus.local) {
      const options = {
        useUpdate,
        extraHeaders: this.props.extraHeaders.hold,
      };
      const done = () => {
        this.setState({ callIsOnHold: true });
      };
      this.state.rtcSession.hold(options, done);
    }
  };

  renegotiate = (options?: RenegotiateOptions, done?: () => void) => {
    if (!this.state.rtcSession) {
      this.logger.warn('renegotiate: no-op as there\'s no active rtcSession');
      return; // no-op
    }

    this.state.rtcSession.renegotiate(options, done);
  };

  callUnhold = (useUpdate = false): void => {
    if (!this.state.rtcSession) {
      this.logger.warn('callUnhold: no-op as there\'s no active rtcSession');
      return; // no-op
    }

    const holdStatus = this.state.rtcSession.isOnHold();
    if (holdStatus.local) {
      const options = {
        useUpdate,
        extraHeaders: this.props.extraHeaders.hold,
      };
      const done = () => {
        this.setState({ callIsOnHold: false });
      };
      this.state.rtcSession.unhold(options, done);
    }

    this.callUnmuteMicrophone();
    this.getRemoteAudioOrFail().muted = false;
    this.getRemoteAudioOrFail().volume = 1;
  };

  callToggleHold = (useUpdate = false): void => {
    if (!this.state.rtcSession) {
      this.logger.warn('callToggleHold: no-op as there\'s no active rtcSession');
      return; // no-op
    }

    const holdStatus = this.state.rtcSession.isOnHold();
    return holdStatus.local ? this.callUnhold(useUpdate) : this.callHold(useUpdate);
  };

  callMuteMicrophone = () => {
    if (this.state.rtcSession && !this.state.callMicrophoneIsMuted) {
      this.state.rtcSession.mute({ audio: true, video: false });
      this.setState({ callMicrophoneIsMuted: true });
    }
  };

  callUnmuteMicrophone = () => {
    if (this.state.rtcSession && this.state.callMicrophoneIsMuted) {
      this.state.rtcSession.unmute({ audio: true, video: false });
      this.setState({ callMicrophoneIsMuted: false });
    }
  };

  callToggleMuteMicrophone = () => this.state.callMicrophoneIsMuted ? this.callUnmuteMicrophone() : this.callMuteMicrophone();

  private getRemoteAudioOrFail(): WebAudioHTMLMediaElement {
    if (!this.remoteAudio) {
      throw new Error('remoteAudio is not initiliazed');
    }

    return this.remoteAudio;
  };

  private createRemoteAudioElement(): WebAudioHTMLMediaElement {
    const id = 'sip-provider-audio';
    let el = window.document.getElementById(id);

    if (el) {
      return el as WebAudioHTMLMediaElement;
    }

    el = window.document.createElement('audio') as WebAudioHTMLMediaElement;
    el.id = id;
    (el as WebAudioHTMLMediaElement).autoplay = true;

    window.document.body.appendChild(el);

    return el as WebAudioHTMLMediaElement;
  }
}
