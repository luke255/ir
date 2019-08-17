const Denon = require('denon-client'),
    denonClient = new Denon.DenonClient('10.0.0.12'),
    HID = require('node-hid'),
    Homeassistant = require('node-homeassistant'),
    piezo = require('rpio-rtttl-piezo'),
    secrets = require('./secrets.json'),
    nodeHue = require('node-hue-api'),
    HueApi = nodeHue.HueApi,
    lightState = nodeHue.lightState;
let app, ha = new Homeassistant({
        host: '10.0.0.5',
        protocol: 'ws',
        password: secrets.ha,
        port: 8123
    }),
    hid = new HID.HID('8352', '1'),
    light = {
        cur: 0,
        inc: 8
    },
    listening = false,
    counter = new Array(2).fill(0),
    vol = {
        min: 20, // Minimum external volume in percent
        inc: 16, // Number of internal volume steps
        init: 7,
        multiplier: 3, // Multipler to calculate external volume percentage step for one internal volume step
    },
    hue = new HueApi('10.0.0.11', secrets.hue),
    state = lightState.create(),
    inp, on, wait;
ha.on('connection', info => {
    console.log('Home Assistant:', info);
});
haConnect();

function haConnect() {
    ha.connect().then(haListen).catch((error) => {
        console.error(error);
        setTimeout(haConnect, 5000);
    });
}

function haListen() {
    if (!listening) {
        console.log('Home Assistant: Listening for events');
        listening = true;
        ha.on('state:light.hgrp_0000000006', data => {
            light.cur = Math.round((Math.sqrt(data['new_state'].attributes.brightness) / 16) * light.inc) || 0;
            console.log('Lights:', light.cur);
        });
        ha.on('state:media_player.shieldtv', data => {
            app = data['new_state'].attributes['app_name'];
            console.log('App activated:', app);
        });
    }
}
denonClient.on('masterVolumeChanged', (volume) => {
    console.log('AVR: volume', volume);
}).on('powerChanged', (stat) => {
    on = (stat === 'ON');
    if (stat === 'ON') vol.cur = vol.init;
    console.log('AVR:', (stat === 'ON' ? 'on' : 'off'));
}).on('muteChanged', (stat) => {
    vol.mute = (stat === 'ON');
    console.log('AVR:', (stat === 'OFF' ? 'un' : '') + 'mute');
}).on('inputChanged', (stat) => {
    inp = stat;
    console.log('AVR: selected', stat, 'input');
}).connect().then(() => {
    console.log('AVR: connected');
    denonClient.getVolume().then((data) => {
        volCon(Math.round((data - vol.min) / vol.multiplier));
    });
    denonClient.getInput().then((data) => {
        inp = data;
    });
    denonClient.getMute().then((data) => {
        vol.mute = (data === 'ON');
    });
    denonClient.getPower().then((data) => {
        on = (data === 'ON');
    });
}).catch((error) => {
    console.error(error);
});
hid.on('data', function(data) {
    data = data.toString('base64');
    switch (data) {
        case 'AQFA': // @ / Power
            tone((on ? 'd=32,o=5,b=125:c6,g,e,c' : 'd=32,o=5,b=125:c,e,g,c6'));
            if (!wait) {
                console.log('Power: disabled');
                wait = true;
                ha.call({
                    domain: 'switch',
                    service: 'toggle',
                    'service_data': {
                        'entity_id': 'switch.tv'
                    }
                });
                setTimeout(function() {
                    wait = false;
                    console.log('Power: enabled');
                }, 7000);
            }
            break;
        case 'AQE/': // ? / Source
            tone(`d=32,o=${inp ? '5' : '6'},b=180:c,p,c`);
            if (inp !== 'MPLAY' && inp !== 'GAME') {
                denonClient.getInput().then((data) => {
                    inp = data;
                    denonClient.setInput((inp !== 'MPLAY' ? 'MPLAY' : 'GAME'));
                });
            }
            denonClient.setInput((inp !== 'MPLAY' ? 'MPLAY' : 'GAME'));
            break;
        case 'AQAx': // \ / Context Menu
            break;
        case 'AQA4': // / / Menu
            ha.call({
                domain: 'androidtv',
                service: 'adb_command',
                'service_data': {
                    'entity_id': 'media_player.shieldtv',
                    'command': 'am start -n org.xbmc.kodi/.Splash'
                }
            });
            if (app === 'Kodi') {
                // {
                //     "entity_id": "media_player.kodi",
                //     "method": "Application.Quit"
                // }
            }
            counters('SOS Mode', 0, 7, () => {
                tone('d=16,o=4,b=180:c');
                ha.call({
                    domain: 'automation',
                    service: 'turn_on',
                    'service_data': {
                        'entity_id': 'automation.post_sos'
                    }
                });
                ha.call({
                    domain: 'switch',
                    service: 'turn_off',
                    'service_data': {
                        'entity_id': 'switch.tv'
                    }
                });
                ha.call({
                    domain: 'androidtv',
                    service: 'adb_command',
                    'service_data': {
                        'entity_id': 'media_player.shieldtv',
                        'command': 'reboot'
                    }
                });
                ha.call({
                    domain: 'homeassistant',
                    service: 'restart'
                });
                process.exit();
            });
            break;
        case 'AQE6': // : / Vol +
            volCon(vol.cur + 1);
            break;
        case 'AQE7': // ; / Vol -
            volCon(vol.cur - 1);
            break;
        case 'AQE8': //< / Mute
            tone((!vol.mute ? 'd=32,o=5,b=125:c6,c' : 'd=32,o=5,b=125:c,c6'));
            ha.call({
                domain: 'media_player',
                service: 'volume_mute',
                'service_data': {
                    'entity_id': 'media_player.av_receiver',
                    'is_volume_muted': (vol.mute === false)
                }
            }).catch((e) => {
                console.log(e);
            });
            break;
        case 'AQE9': // = / Channel +
            lightCon(light.cur + 1);
            break;
        case 'AQE+': // > / Channel -
            lightCon(light.cur - 1);
            break;
    }
});

function volCon(volNew) {
    if (volNew <= 0) {
        volNew = 0;
        bip(-1);
    } else if (volNew >= vol.inc) {
        volNew = vol.inc;
        bip(1);
    } else {
        bip(0);
    }
    vol.cur = volNew;
    denonClient.setVolume((volNew * vol.multiplier) + vol.min);
}

function lightCon(lightNew) {
    if (lightNew <= 0) {
        lightNew = 0;
        bip(-1);
    } else if (lightNew >= light.inc) {
        lightNew = light.inc;
        bip(1);
    } else {
        bip(0);
    }
    light.cur = lightNew;
    if (lightNew === 0) {
        hue.setGroupLightState(2, state.off()).done();
    } else {
        hue.setGroupLightState(2, state.on().bri(Math.pow((lightNew / light.inc) * 16, 2))).done();
    }
}

function tone(code) {
    piezo.play({
        pwmOutputPin: 33,
        rtttl: 'ir:' + (wait ? 'd=32,o=4,b=180:c,p,c' : code),
        dutyCycle: 2,
        freqMultiplier: 1
    });
}

function bip(ind) {
    tone(`d=32,o=${ind + 5},b=400:c`);
}

function pc(turnOn) {
    ha.call({
        domain: 'switch',
        service: `turn_${turnOn ? 'on' : 'off'}`,
        'service_data': {
            'entity_id': 'switch.pc'
        }
    }).catch((e) => {
        console.log(e);
    });
}function counters(name, counterNumber, func) {
    if (counter[counterNumber] === 0) {
        console.log(name + ' Armed');
        setTimeout(() => {
            if (counter[counterNumber] > 7) {
                console.log(name + ' Triggered!');
                func();
            } else {
                console.log(name + ' Disarmed');
                counter[counterNumber] = 0;
            }
        }, 2000);
    }
    counter[counterNumber]++;
}
