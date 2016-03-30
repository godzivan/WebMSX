// Copyright 2015 by Paulo Augusto Peccin. See license.txt distributed with this file.

// YM2413 FM Sound Chip
// Implementation based on the excellent findings and measurements by Wouter Vermaelen
// Instrument settings based on Okazaki's and Burczynski's

// TODO How changes in parameters affect envelopes in progress

wmsx.YM2413MixedAudioChannels = function(name) {

    function init(self) {
        var tabs = new wmsx.YM2413Tables();
        sineTable = tabs.getFullSineTable();
        halfSineTable = tabs.getHalfSineTable();
        expTable =  tabs.getExpTable();
        instrumentsParameters = tabs.getInstrumentsROM();
        multiFactors = tabs.getMultiFactorsDoubled();
        vibValues = tabs.getVIBValues();
        kslValues = tabs.getKSLValues();
        rateAttackDurTable = tabs.getRateAttackDurations();
        rateDecayDurTable = tabs.getRateDecayDurations();
        self.reset();
    }

    this.connect = function(machine) {
        machine.bus.connectInputDevice( 0x7c, wmsx.DeviceMissing.inputPortIgnored);
        machine.bus.connectInputDevice( 0x7d, wmsx.DeviceMissing.inputPortIgnored);
        machine.bus.connectOutputDevice(0x7c, this.output7C);
        machine.bus.connectOutputDevice(0x7d, this.output7D);
        audioSocket = machine.getAudioSocket();
    };

    this.disconnect = function(machine) {
        machine.bus.disconnectInputDevice( 0x7c, wmsx.DeviceMissing.inputPortIgnored);
        machine.bus.disconnectInputDevice( 0x7d, wmsx.DeviceMissing.inputPortIgnored);
        machine.bus.disconnectOutputDevice(0x7c, this.output7C);
        machine.bus.disconnectOutputDevice(0x7d, this.output7D);
        this.disconnectAudio();
    };

    // Port not available for INPUT
    this.inputNotAvailable = function() {
        return 0xff;
    };

    this.output7C = function (val) {
        registerAddress = val & 0x3f;
    };

    this.output7D = function (val) {
        registerWrite(registerAddress, val);
    };

    this.reset = function() {
        // Starting conditions
        clock = 0;
        noiseRegister = 0xffff; noiseOutput = 0;
        amLevel = 0; amLevelInc = -1;
        vibPhase = 0;
        // Reset all envelope controls
        for (var chan = 0; chan < 9; ++chan) {
            setEnvStep(chan, IDLE);
            updateAllAttenuations(chan);
        }
        // Zero all registers
        for (var reg = 0; reg < 0x39; ++reg) registerWrite(reg, 0);
    };

    this.nextSample = function() {
        var amChanged, vibChanged = false;
        var m, c, mPh, cPh, fb, mod;

        ++clock;
        amChanged = clockAM();
        if (amChanged) vibChanged = clockVIB();

        var sample = 0;
        var topMelodyChan = rhythmMode ? 5 : 8;

        // Melody channels
        for (var chan = topMelodyChan; chan >= 0; --chan) {
            m = chan << 1; c = m + 1;
            if (envStep[c] === IDLE) continue;

            // Update AM and VIB
            if (amChanged) {
                if (am[m]) updateAMAttenuationOp(m);
                if (am[c]) updateAMAttenuationOp(c);
                if (vibChanged) {
                    if (vib[m]) updateFrequencyOp(m);
                    if (vib[c]) updateFrequencyOp(c);
                }
            }

            // Update ADSR envelopes
            if (envStep[m] !== IDLE) clockEnvelope(m);
            clockEnvelope(c);

            // Update operators phase (0..1023)
            mPh = ((phaseCounter[m] += phaseInc[m]) >> 9) - 1;   // Modulator phase is 1 behind Carrier
            cPh =  (phaseCounter[c] += phaseInc[c]) >> 9;

            // Modulator and Feedback
            if (fbShift[chan] < 31) {
                fb = (fbLastMod1[chan] + fbLastMod2[chan]) >> 1 >> fbShift[chan];         // >> 1 because last 2 values sum must be divided by 2
                mod = expTable[(halfWave[m] ? halfSineTable : sineTable)[(mPh + fb) & 1023] + totalAtt[m]];
                fbLastMod2[chan] = fbLastMod1[chan];
                fbLastMod1[chan] = mod;
            } else {
                mod = expTable[(halfWave[m] ? halfSineTable : sineTable)[mPh & 1023] + totalAtt[m]];
            }

            // Modulated Carrier, final sample value
            sample += expTable[(halfWave[c] ? halfSineTable : sineTable)[(cPh + mod) & 1023] + totalAtt[c]] >> 4;
        }

        // Rhythm channels (no AM, VIB, KSR, KSL, DC/DM, FB)
        if (rhythmMode) {
            clockNoise();

            // Bass Drum, 2 ops, normal channel
            c = 13;
            if (envStep[c] !== IDLE) {
                m = 12;
                clockEnvelope(m);
                clockEnvelope(c);
                mPh = ((phaseCounter[m] += phaseInc[m]) >> 9) - 1;
                cPh =  (phaseCounter[c] += phaseInc[c]) >> 9;
                mod = expTable[sineTable[mPh & 1023] + totalAtt[m]];
                sample += expTable[sineTable[(cPh + mod) & 1023] + totalAtt[c]] >> 3;
            }

            // Snare Drum, 1 op + noise
            c = 15;
            if (envStep[c] !== IDLE) {
                clockEnvelope(c);
                cPh = (phaseCounter[c] += phaseInc[c]) >> 9;
                sample += expTable[sineTable[cPh & 0x100 ? noiseOutput ? 0 : 100 : noiseOutput ? 0 : 1023 - 100] + totalAtt[c]] >> 3;
            }

            // Tom Tom, 1op, no noise
            c = 16;
            if (envStep[c] !== IDLE) {
                clockEnvelope(c);
                cPh = (phaseCounter[c] += phaseInc[c]) >> 9;
                sample += expTable[sineTable[cPh & 1023] + totalAtt[c]] >> 3;
            }

            // Cymbal & HiHat
            if (envStep[17] !== IDLE || envStep[14] !== IDLE) {
                // Both share the same phase calculation
                var ph14 = (phaseCounter[14] += phaseInc[14]) >> 9;
                var ph17 = (phaseCounter[17] += phaseInc[17]) >> 9;
                var hhCymPh = (((ph17 & 0x4) != 0) && ((ph17 & 0x10) == 0)) !=
                                ((((ph14 & 0x02) != 0) != ((ph14 & 0x100) != 0)) || ((ph14 & 0x04) != 0));

                // Cymbal, 1 op, no noise
                c = 17;
                if (envStep[c] !== IDLE) {
                    clockEnvelope(c);
                    sample += expTable[sineTable[hhCymPh ? 200 : 1023 - 200] + totalAtt[c]] >> 3;
                }

                // HiHat, 1op + noise
                c = 14;
                if (envStep[c] !== IDLE) {
                    clockEnvelope(c);
                    sample += expTable[sineTable[hhCymPh ? noiseOutput ? 40 : 10 : noiseOutput ? 1023 - 40 : 1023 - 10] + totalAtt[c]] >> 3;
                }
            }
        }

        return sample;
    };

    this.connectAudio = function() {
        if (!audioSignal) audioSignal = new wmsx.AudioSignal(name, this, this.SAMPLE_RATE, this.VOLUME);
        audioSignal.signalOn();
        audioSocket.connectAudioSignal(audioSignal);
    };

    this.disconnectAudio = function() {
        if (audioSignal) {
            audioSignal.signalOff();
            audioSocket.disconnectAudioSignal(audioSignal);
        }
    };

    function registerWrite(reg, val) {

        //console.log("Register: " + reg.toString(16) + " write: " + val);

        var chan = reg & 0xf;
        if (chan > 8) chan -= 9;                       // Regs X9 - Xf are the same as X0 - X6
        var m = chan << 1, c = m + 1;

        var mod = register[reg] ^ val;
        register[reg] = val;

        switch(reg) {
            case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07:
                if (mod) {
                    instrumentsParameters[0][reg] = val;
                    updateCustomInstrChannels();
                }
                break;
            case 0x0e:
                if (mod & 0x20) setRhythmMode((val & 0x20) !== 0);
                if (rhythmMode) {
                    if (mod & 0x10) {                                             // Bass Drum    (2 ops, like a melody channel)
                        setRhythmKeyOnOp(12, (val & 0x10) !== 0);
                        setRhythmKeyOnOp(13, (val & 0x10) !== 0);
                    }
                    if (mod & 0x08) setRhythmKeyOnOp(15, (val & 0x08) !== 0);     // Snare Drum   (1 op)
                    if (mod & 0x04) setRhythmKeyOnOp(16, (val & 0x04) !== 0);     // Tom Tom      (1 op)
                    if (mod & 0x02) setRhythmKeyOnOp(17, (val & 0x02) !== 0);     // Top Cymbal   (1 op)
                    if (mod & 0x01) setRhythmKeyOnOp(14, (val & 0x01) !== 0);     // HiHat        (1 op)
                }
                break;
            case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16: case 0x17: case 0x18:
            case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f:
                if (mod) {
                    fNum[m] = (fNum[m] & ~0xff) | val;
                    fNum[c] = fNum[m];
                    updateFrequency(chan);
                }
                break;
            case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f:
                if (mod & 0x20) setSustain(chan, (val & 0x20) >> 5);
                if (mod & 0x10) setKeyOn(chan, (val & 0x10) >> 4);
                if (mod & 0x01) {
                    fNum[m] = (fNum[m] & ~0x100) | ((val & 1) << 8);
                    fNum[c] = fNum[m];
                }
                if (mod & 0x0e) {
                    block[m] = (val >> 1) & 0x7;
                    block[c] = block[m];
                }
                if (mod & 0x0f) updateFrequency(chan);
                break;
            case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: case 0x38:
            case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: case 0x3f:
                if (rhythmMode && chan > 5) {
                    if (mod & 0xf0) setVolumeOp(m, val >>> 4);
                    if (mod & 0x0f) setVolumeOp(c, val & 0xf);
                } else {
                    if (mod & 0xf0) setInstr(chan, val >>> 4);
                    if (mod & 0x0f) setVolumeOp(c, val & 0xf);
                }
                break;
        }
    }

    function clockNoise() {
        noiseRegister >>= 1;
        noiseOutput = noiseRegister & 1;
        if (noiseOutput) noiseRegister ^= 0x8003020;
    }

    function clockAM() {
        if (clock & 511) return false;        // Only change once each 512 clocks

        if (amLevel === 0 || amLevel === 13) amLevelInc = -amLevelInc;
        amLevel += amLevelInc;
        return true;
    }

    function clockVIB() {
        if (clock & 1023) return false;        // Only change once each 1024 clocks

        vibPhase = (clock >> 10) & 0x7;
        return true;
    }

    function clockEnvelope(op) {
        if (envLevel[op] === envStepNextAtLevel[op]) {
            setEnvStepOp(op, envStepNext[op]);
        } else {
            if (clock >= envStepLevelIncClock[op]) {
                envStepLevelIncClock[op] += envStepLevelDur[op];
                envLevel[op] += envStepLevelInc[op];
                updateEnvAttenuationOp(op);
            }
        }
    }

    function setSustain(chan, on) {
        sustain[chan] = on;
    }

    function setKeyOn(chan, on) {
        var m = chan << 1, c = m + 1;
        keyOn[m] = on;
        keyOn[c] = on;
        // Define ADSR phase
        if (on) {
            setEnvStep(chan, DAMP);
        } else {
            // Modulator is not affected by KEY-OFF!
            if (envStep[c] !== IDLE) setEnvStepOp(c, RELEASE);
        }
    }

    function setRhythmKeyOnOp(op, on) {
        keyOn[op] = on;
        // Define ADSR phase
        if (on) {
            setEnvStepOp(op, DAMP);
        } else {
            if (envStep[op] !== IDLE) setEnvStepOp(op, RELEASE);
        }
    }

    function  setEnvStep(chan, step) {
        var m = chan << 1, c = m + 1;
        setEnvStepOp(m, step);
        setEnvStepOp(c, step);
    }

    function setEnvStepOp(op, step) {
        envStep[op] = step;
        switch (step) {
            case DAMP:
                envStepLevelDur[op] = rateDecayDurTable[(12 << 2) + ksrOffset[op]];
                envStepLevelIncClock[op] = clock + envStepLevelDur[op];
                envStepLevelInc[op] = 1;
                envStepNextAtLevel[op] = 128;
                envStepNext[op] = ATTACK;
                break;
            case ATTACK:
                envStepLevelDur[op] = rateAttackDurTable[(ar[op] << 2) + ksrOffset[op]];
                envStepLevelIncClock[op] = clock + envStepLevelDur[op];
                envStepLevelInc[op] = -8;
                envStepNextAtLevel[op] = 0;
                envStepNext[op] = DECAY;
                // Reset phase counter ?
                phaseCounter[op] = 0;
                break;
            case DECAY:
                envStepLevelDur[op] = rateDecayDurTable[(dr[op] << 2) + ksrOffset[op]];
                envStepLevelIncClock[op] = clock + envStepLevelDur[op];
                envStepLevelInc[op] = 1;
                envStepNextAtLevel[op] = sl[op] << 3;
                envStepNext[op] = SUSTAIN;
                break;
            case SUSTAIN:
                if (envType[op]) {
                    // Sustained tone
                    envStepLevelIncClock[op] = envStepLevelDur[op] = -1;
                    envStepLevelInc[op] = 0;
                    envStepNextAtLevel[op] = null;
                    envStepNext[op] = null;
                } else {
                    // Percussive tone
                    envStepLevelDur[op] = rateDecayDurTable[(rr[op] << 2) + ksrOffset[op]];
                    envStepLevelIncClock[op] = clock + envStepLevelDur[op];
                    envStepLevelInc[op] = 1;
                    envStepNextAtLevel[op] = 128;
                    envStepNext[op] = IDLE;
                }
                break;
            case RELEASE:
                var rate = envType[op]
                    ? sustain[op >> 1] ? 5 : rr[op]     // Sustained tone
                    : sustain[op >> 1] ? 5 : 7;         // Percussive tone
                envStepLevelDur[op] = rateDecayDurTable[(rate << 2) + ksrOffset[op]];
                envStepLevelIncClock[op] = clock + envStepLevelDur[op];
                envStepLevelInc[op] = 1;
                envStepNextAtLevel[op] = 128;
                envStepNext[op] = IDLE;
                break;
            case IDLE:
            default:
                envLevel[op] = 128;
                envStepLevelIncClock[op] = envStepLevelDur[op] = -1;
                envStepLevelInc[op] = 0;
                envStepNextAtLevel[op] = null;
                envStepNext[op] = null;
                break;
        }
    }

    function setRhythmMode(boo) {
        rhythmMode = boo;
        setEnvStep(6, IDLE); updateEnvAttenuation(6);
        setEnvStep(7, IDLE); updateEnvAttenuation(7);
        setEnvStep(8, IDLE); updateEnvAttenuation(8);
        if (rhythmMode) {
            setInstr(6, 16);
            setInstr(7, 17);
            setInstr(8, 18);
        } else {
            setInstr(6, register[36] >> 4);
            setInstr(7, register[37] >> 4);
            setInstr(8, register[38] >> 4);
        }
    }

    function setInstr(chan, ins) {
        instr[chan] = ins;

        // Copy parameters
        var m = chan << 1, c = m + 1;
        var pars = instrumentsParameters[ins];
        am[m] =         (pars[0] >> 7) & 1;
        am[c] =         (pars[0] >> 7) & 1;
        vib[m] =        (pars[0] >> 6) & 1;
        vib[c] =        (pars[0] >> 6) & 1;
        envType[m] =    (pars[0] >> 5) & 1;
        envType[c] =    (pars[1] >> 5) & 1;
        ksr[m] =        (pars[0] >> 4) & 1;
        ksr[c] =        (pars[1] >> 4) & 1;
        multi[m] =      multiFactors[pars[0] & 0xf];
        multi[c] =      multiFactors[pars[1] & 0xf];
        ksl[m] =        pars[2] >>> 6;
        ksl[c] =        pars[3] >>> 6;
        modTL[m] =      pars[2] & 0x3f;
        halfWave[m] =   (pars[3] >> 3) & 1;
        halfWave[c] =   (pars[3] >> 4) & 1;
        fbShift[chan] = (pars[3] & 0x7) ? 8 - (pars[3] & 0x7) : 31;   // Maximum shift value to discard all bits when FB = off
        ar[m] =         pars[4] >>> 4;
        dr[m] =         pars[4] & 0xf;
        ar[c] =         pars[5] >>> 4;
        dr[c] =         pars[5] & 0xf;
        sl[m] =         pars[6] >>> 4;
        rr[m] =         pars[6] & 0xf;
        sl[c] =         pars[7] >>> 4;
        rr[c] =         pars[7] & 0xf;

        updateAMAttenuation(chan);
        updateFrequency(chan);
        updateModAttenuationOp(m);

        //console.log("Custom Instr updated for channel: " + chan);
    }

    function updateCustomInstrChannels() {
        for (var chan = 0; chan < 9; chan++)
            if (instr[chan] === 0) setInstr(chan, 0);
    }

    function setVolumeOp(op, val) {
        volume[op] = val;
        updateVolumeAttenuationOp(op);
    }

    function updateFrequency(chan) {
        var m = chan << 1, c = m + 1;
        var vibVal = vib[m] ? vibValues[fNum[m] >> 6][vibPhase] : 0;
        phaseInc[m] = ((((fNum[m] << 1) + vibVal) * multi[m])) << block[m] >> 2;    // Take back the MULTI doubling in the table (>> 1) and the fNum doubling here. Do this because we must use half of vib value, without losing precision in the shift operations
            vibVal = vib[c] ? vibValues[fNum[c] >> 6][vibPhase] : 0;
        phaseInc[c] = ((((fNum[c] << 1) + vibVal) * multi[c])) << block[c] >> 2;
        updateKSLAttenuation(chan);
        updateKSROffset(chan);
    }

    function updateFrequencyOp(op) {
        var vibVal = vib[op] ? vibValues[fNum[op] >> 6][vibPhase] : 0;
        phaseInc[op] = ((((fNum[op] << 1) + vibVal) * multi[op])) << block[op] >> 2;
        updateKSLAttenuationOp(op);
        updateKSROffsetOp(op);
    }

    function updateKSROffset(chan) {
        var m = chan << 1, c = m + 1;
        ksrOffset[m] = (ksr[m] ? block[m] << 1 : block[m] >> 1) | (fNum[m] >>> (9 - ksr[m]));
        ksrOffset[c] = (ksr[c] ? block[c] << 1 : block[c] >> 1) | (fNum[c] >>> (9 - ksr[c]));
    }

    function updateKSROffsetOp(op) {
        ksrOffset[op] = (ksr[op] ? block[op] << 1 : block[op] >> 1) | (fNum[op] >>> (9 - ksr[op]));
    }

    function updateAMAttenuation(chan) {
        var m = chan << 1, c = m + 1;
        amAtt[m] = am[m] ? amLevel << 4 : 0;
        amAtt[c] = am[c] ? amLevel << 4 : 0;
        updateTotalAttenuation(chan);
    }

    function updateAMAttenuationOp(op) {
        amAtt[op] = am[op] ? amLevel << 4 : 0;
        updateTotalAttenuationOp(op);
    }

    function updateKSLAttenuation(chan) {
        var m = chan << 1, c = m + 1;
        kslAtt[m] = kslValues[ksl[m]][block[m]][fNum[m] >>> 5] << 4;
        kslAtt[c] = kslValues[ksl[c]][block[c]][fNum[c] >>> 5] << 4;
        updateTotalAttenuation(chan);
    }

    function updateKSLAttenuationOp(op) {
        kslAtt[op] = kslValues[ksl[op]][block[op]][fNum[op] >>> 5] << 4;
        updateTotalAttenuationOp(op);
    }

    function updateEnvAttenuation(chan) {
        var m = chan << 1, c = m + 1;
        envAtt[m] = (envLevel[m] === 128 ? 256 : envLevel[m]) << 4;            // Higher attenuation in case of minimum level to produce silence
        envAtt[c] = (envLevel[c] === 128 ? 256 : envLevel[c]) << 4;
        updateTotalAttenuation(chan);
    }

    function updateEnvAttenuationOp(op) {
        envAtt[op] = (envLevel[op] === 128 ? 256 : envLevel[op]) << 4;         // Higher attenuation in case of minimum level to produce silence
        updateTotalAttenuationOp(op);
    }

    function updateModAttenuationOp(op) {
        volModAtt[op] = modTL[op] << 5;
        updateTotalAttenuationOp(op);
    }

    function updateVolumeAttenuationOp(op) {
        volModAtt[op] = (volume[op] === 15 ? 30 : volume[op]) << 7;            // Higher attenuation in case of minimum volume to produce silence
        updateTotalAttenuationOp(op);
    }

    function updateTotalAttenuation(chan) {
        var m = chan << 1, c = m + 1;
        totalAtt[m] = amAtt[m] + kslAtt[m] + envAtt[m] + volModAtt[m];
        totalAtt[c] = amAtt[c] + kslAtt[c] + envAtt[c] + volModAtt[c];
    }

    function updateTotalAttenuationOp(op) {
        totalAtt[op] = amAtt[op] + kslAtt[op] + envAtt[op] + volModAtt[op];
    }

    function updateAllAttenuations(chan) {
        var m = chan << 1, c = m + 1;
        updateAMAttenuation(chan);
        updateKSLAttenuation(chan);
        updateEnvAttenuation(chan);
        updateModAttenuationOp(m);
        updateVolumeAttenuationOp(c);
    }


    // Constants

    var IDLE = -1, DAMP = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;       // Envelope steps
    var MAX_INT = 9007199254740991;

    // Dynamic global values. Change as time passes
    var clock;
    var noiseRegister, noiseOutput;
    var amLevel, amLevelInc;
    var vibPhase;

    // Global settings
    var registerAddress;
    var register = wmsx.Util.arrayFill(new Array(0x38), 0);
    var rhythmMode;

    // Settings per channel(9) / operator(18)
    var sustain =  wmsx.Util.arrayFill(new Array(9), 0);
    var instr =    wmsx.Util.arrayFill(new Array(9), 0);
    var keyOn =    wmsx.Util.arrayFill(new Array(18), 0);
    var am =       wmsx.Util.arrayFill(new Array(18), 0);
    var vib =      wmsx.Util.arrayFill(new Array(18), 0);
    var envType =  wmsx.Util.arrayFill(new Array(18), 0);
    var ksr =      wmsx.Util.arrayFill(new Array(18), 0);
    var multi =    wmsx.Util.arrayFill(new Array(18), 0);
    var ksl =      wmsx.Util.arrayFill(new Array(18), 0);
    var halfWave = wmsx.Util.arrayFill(new Array(18), 0);
    var ar =       wmsx.Util.arrayFill(new Array(18), 0);
    var dr =       wmsx.Util.arrayFill(new Array(18), 0);
    var sl =       wmsx.Util.arrayFill(new Array(18), 0);
    var rr =       wmsx.Util.arrayFill(new Array(18), 0);
    var fNum  =    wmsx.Util.arrayFill(new Array(18), 0);
    var block =    wmsx.Util.arrayFill(new Array(18), 0);
    var volume =   wmsx.Util.arrayFill(new Array(18), 0);
    var modTL =    wmsx.Util.arrayFill(new Array(18), 0);

    // Computed settings per channel(9) / operator(18)
    var fbShift =   wmsx.Util.arrayFill(new Array(9), 0);
    var volModAtt = wmsx.Util.arrayFill(new Array(18), 0);       // For Volume or ModTL

    // Dynamic values per channel(9) / operator(18). May change as time passes without being set by software
    var amAtt =    wmsx.Util.arrayFill(new Array(18), 0);
    var envAtt =   wmsx.Util.arrayFill(new Array(18), 0);
    var kslAtt =   wmsx.Util.arrayFill(new Array(18), 0);
    var totalAtt = wmsx.Util.arrayFill(new Array(18), 0);

    var envStep =              wmsx.Util.arrayFill(new Array(18), 0);
    var envStepLevelDur =      wmsx.Util.arrayFill(new Array(18), 0);
    var envStepLevelIncClock = wmsx.Util.arrayFill(new Array(18), 0);
    var envStepLevelInc =      wmsx.Util.arrayFill(new Array(18), 0);
    var envStepNext =          wmsx.Util.arrayFill(new Array(18), 0);
    var envStepNextAtLevel =   wmsx.Util.arrayFill(new Array(18), 0);
    var envLevel =             wmsx.Util.arrayFill(new Array(18), 0);

    var ksrOffset =    wmsx.Util.arrayFill(new Array(18), 0);

    var fbLastMod1 = wmsx.Util.arrayFill(new Array(9), 0);
    var fbLastMod2 = wmsx.Util.arrayFill(new Array(9), 0);

    var phaseInc =     wmsx.Util.arrayFill(new Array(18), 0);
    var phaseCounter = wmsx.Util.arrayFill(new Array(18), 0);


    // Debug vars

    this.register = register;

    this.keyOn = keyOn;
    this.sustain = sustain;
    this.fNum = fNum;
    this.block = block;
    this.instr = instr;
    this.volume = volume;
    this.modTL = modTL;

    this.am = am;
    this.vib = vib;
    this.envType = envType;
    this.ksr = ksr;
    this.multi = multi;
    this.ksl = ksl;
    this.halfWave = halfWave;
    this.ar = ar;
    this.dr = dr;
    this.sl = sl;
    this.rr = rr;
    this.ksrOffset = ksrOffset;

    this.kslAtt = kslAtt;
    this.fbShift = fbShift;
    this.envAtt = envAtt;
    this.amAtt = amAtt;
    this.volModAtt = volModAtt;
    this.totalAtt = totalAtt;

    this.envStep = envStep;
    this.envStepLevelDur = envStepLevelDur;
    this.envStepLevelIncClock = envStepLevelIncClock;
    this.envStepNext = envStepNext;
    this.envStepNextAtLevel = envStepNextAtLevel;
    this.envStepLevelInc = envStepLevelInc;
    this.envLevel = envLevel;

    this.phaseInc = phaseInc;
    this.phaseCounter = phaseCounter;

    // Pre calculated tables, factors, values

    var sineTable, halfSineTable, expTable, instrumentsParameters, multiFactors, vibValues, kslValues, rateAttackDurTable, rateDecayDurTable;

    var audioSocket, audioSignal;

    this.VOLUME = 0.80 / 9 / 256;
    this.SAMPLE_RATE = wmsx.Machine.BASE_CPU_CLOCK / 72;                 // Main CPU clock / 72 = 49780hz


    // Savestate  -------------------------------------------

    this.saveState = function() {
        return {
            ra: registerAddress,
            r: wmsx.Util.storeInt8BitArrayToStringBase64(register),

            c: clock,
            nr: noiseRegister, no: noiseOutput,
            al: amLevel, ai: amLevelInc, vp: vibPhase,

            amt: wmsx.Util.storeInt32BitArrayToStringBase64(amAtt),
            evt: wmsx.Util.storeInt32BitArrayToStringBase64(envAtt),
            kst: wmsx.Util.storeInt32BitArrayToStringBase64(kslAtt),
            tot: wmsx.Util.storeInt32BitArrayToStringBase64(totalAtt),

            evs: wmsx.Util.storeInt8BitArrayToStringBase64(envStep),
            evd: envStepLevelDur,
            evc: envStepLevelIncClock,
            evi: envStepLevelInc,
            evn: wmsx.Util.storeInt8BitArrayToStringBase64(envStepNext),
            evl: wmsx.Util.storeInt8BitArrayToStringBase64(envStepNextAtLevel),
            eve: wmsx.Util.storeInt8BitArrayToStringBase64(envLevel),
            kso: wmsx.Util.storeInt8BitArrayToStringBase64(ksrOffset),

            fb1: wmsx.Util.storeInt32BitArrayToStringBase64(fbLastMod1),
            fb2: wmsx.Util.storeInt32BitArrayToStringBase64(fbLastMod2),

            phi: phaseInc,
            phc: phaseCounter
        };
    };

    this.loadState = function(s) {
        this.reset();

        registerAddress = s.ra;
        var regs = wmsx.Util.restoreStringBase64ToInt8BitArray(s.r);
        for (var r = 0; r < regs.length; r++) registerWrite(r, regs[r]);

        clock = s.c;
        noiseRegister = s.nr; noiseOutput = s.no;
        amLevel = s.al; amLevelInc = s.ai; vibPhase = s.vp;

        amAtt = wmsx.Util.restoreStringBase64ToInt32BitArray(s.amt, amAtt);
        envAtt = wmsx.Util.restoreStringBase64ToInt32BitArray(s.evt, envAtt);
        kslAtt = wmsx.Util.restoreStringBase64ToInt32BitArray(s.kst, kslAtt);
        totalAtt = wmsx.Util.restoreStringBase64ToInt32BitArray(s.tot, totalAtt);

        envStep = wmsx.Util.restoreStringBase64ToInt8BitArray(s.evs, envStep);
        envStepLevelDur = s.evd;
        envStepLevelIncClock = s.evc;
        envStepLevelInc = s.evi;
        envStepNext = wmsx.Util.restoreStringBase64ToInt8BitArray(s.evn, envStepNext);
        envStepNextAtLevel = wmsx.Util.restoreStringBase64ToInt8BitArray(s.evl, envStepNextAtLevel);
        envLevel = wmsx.Util.restoreStringBase64ToInt8BitArray(s.eve, envLevel);
        ksrOffset = wmsx.Util.restoreStringBase64ToInt8BitArray(s.kso, ksrOffset);

        fbLastMod1 = wmsx.Util.restoreStringBase64ToInt32BitArray(s.fb1, fbLastMod1);
        fbLastMod2 = wmsx.Util.restoreStringBase64ToInt32BitArray(s.fb2, fbLastMod2);

        phaseInc = s.phi;
        phaseCounter = s.phc;
    };


    init(this);

    FM = this;

    this.eval = function(str) {
        return eval(str);
    };

};