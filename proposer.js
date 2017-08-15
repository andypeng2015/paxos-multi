var Monotonic = require('monotonic').asString

var Completion = require('./completion')

// TODO Convert from a government structure.
function Proposer (paxos, promise) {
    this._paxos = paxos
    this.version = [ promise, this.collapsed = true ]
    this.promise = Monotonic.increment(promise, 0)
    this.previous = null
    this.proposal = null
}

Proposer.prototype.unshift = function (proposal) {
    this.proposal = proposal
}

Proposer.prototype.nudge = function (now) {
    this.prepare(now)
}

Proposer.prototype.prepare = function (now) {
    this._paxos._send({
        method: 'prepare',
        version: this.version,
        to: this.proposal.quorum,
        sync: [],
        promise: this.promise
    })
}

function getPromise (object) {
    return object == null ? '0/0' : object.promise
}

Proposer.prototype.response = function (now, request, responses, promise) {
    switch (promise == null ? request.method : 'failed') {
    case 'failed':
        this.promise = Monotonic.increment(promise, 0)
        // TODO Backoff and try again.
        throw new Error
        break
    case 'prepare':
        for (var id in responses) {
            if (Monotonic.compare(getPromise(this.previous), getPromise(responses[id].register)) < 0) {
                this.previous = responses[id].register
            }
        }
        this._paxos._send({
            method: 'accept',
            version: this.version,
            to: this.proposal.quorum,
            sync: [],
            promise: this.promise,
            body: this.proposal.body,
            previous: this.previous
        })
        break
    case 'accept':
        this._paxos._send({
            method: 'commit',
            version: this.version,
            to: this.proposal.quorum,
            sync: [],
            promise: this.promise
        })
        break
    case 'commit':
        break
    }
}

Proposer.prototype.createWriter = function (promise) {
    return new Completion(this._paxos, this.version, promise)
}

module.exports = Proposer