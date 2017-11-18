React SIP
===

React wrapper for [jssip](https://github.com/versatica/JsSIP).


Installation
---

```bash
npm install react-sip
```

There is no need to install `jssip` as it is a dependency of `react-sip`.


Usage
---

```js
import { SipProvider } from 'react-sip';
import App from './components/App';  

ReactDOM.render(
  <SipProvider
    host="sip.example.com"
    port={7443}
    user="alice"
    password={sipPassword} // usually required (e.g. from ENV or props)
    autoRegister={true} // true by default, see jssip.UA option register
    autoAnswer={false} // automatically answer incoming calls; false by default
    sessionTimersExpires={120} // value for Session-Expires header; 120 by default
    extraHeaders={{ // optional sip headers to send
      register: ['X-Foo: foo', 'X-Bar: bar'],
      invite: ['X-Foo: foo2', 'X-Bar: bar2']
    }}
    iceServers={[ // optional
      { urls: ['stun:a.example.com', 'stun:b.example.com'] },
      { urls: 'turn:example.com', username: 'foo', credential: '1234' }
    ]}
    debug={false} // whether to output events to console; false by default
  >
    <App />
  </SipProvider>
  document.getElementById('root'),
);
```

Child components get access to this context:

```js
{
  sip: PropTypes.shape({
    status: PropTypes.string,
    errorType: PropTypes.string,
    errorMessage: PropTypes.string,

    host: PropTypes.string,
    port: PropTypes.number,
    user: PropTypes.string,
    password: PropTypes.string,
    autoRegister: PropTypes.bool,
    autoAnswer: PropTypes.bool,
    sessionTimersExpires: PropTypes.number,
    extraHeaders: PropTypes.obj,
    iceServers: PropTypes.obj,
    debug: PropTypes.bool,
  }),

  call: PropTypes.shape({
    id: PropTypes.string,
    status: PropTypes.string,
    direction: PropTypes.string,
    counterpart: PropTypes.string,
  }),

  registerSip: PropTypes.func,
  unregisterSip: PropTypes.func,

  startCall: PropTypes.func,
  stopCall: PropTypes.func,
  answerCall: PropTypes.func,
}
```

### sip

`sip.status` represents SIP connection status and equals to one of these values:

* `'sipStatus/DISCONNECTED'` when `host`, `port` or `user` is not defined
* `'sipStatus/CONNECTING'`
* `'sipStatus/CONNECTED'`
* `'sipStatus/REGISTERED'` after calling `registerSip` or after `'sipStatus/CONNECTED'` when `autoRegister` is true
* `'sipStatus/ERROR'` in case of configuration, connection or registration problems

`sip.errorType`:

* `'sipErrorType/CONFIGURATION'`
* `'sipErrorType/CONNECTION'`
* `'sipErrorType/REGISTRATION'`

### call

`call.id` is a unique session id of the actual established voice call; `undefined` between calls

`call.status` represents the status of the call:

* `'callStatus/IDLE'` between calls (even when disconnected)
* `'callStatus/STARTING'` active incoming or outgoing call request
* `'callStatus/ACTIVE'` during ongoing call
* `'callStatus/STOPPING'` during call cancelation request

`call.direction` indicates the direction of the ongoing call:

* `null` between calls
* `'callDirection/INCOMING'`
* `'callDirection/OUTGOING'`

`call.counterpart` represents the call _destination_ in case of outgoing call and _caller_ for
incoming calls.
The format depends on the configuration of the SIP server (e.g. `"bob" <+441234567890@sip.example.com>`, `+441234567890@sip.example.com` or `bob@sip.example.com`).

### methods

When `autoRegister` is set to `false`, you can call `sipRegister()` and `sipUnregister()` manually for advanced registration scenarios.

To make calls, simply use these functions:

* `startCall(destination)`
* `answerCall()`
* `stopCall()`

The value for `destination` argument equals to the target SIP user without the host part (e.g. `+441234567890` or `bob`).
The omitted host part is equal to host you’ve defined in `SipProvider` props (e.g. `sip.example.com`).

---

The values for `sip.status`, `sip.errorType`, `call.status` and `call.direction` can be imported as constants to make typos easier to detect:

```js
import {
  SIP_STATUS_DISCONNECTED,
//SIP_STATUS_...,

  CALL_STATUS_IDLE,
//CALL_STATUS_...,

  SIP_ERROR_TYPE_CONFIGURATION,
//SIP_ERROR_TYPE_...,

  CALL_DIRECTION_INCOMING,
  CALL_DIRECTION_OUTGOING,
} from 'react-sip';
```
