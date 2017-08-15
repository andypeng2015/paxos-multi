// Common utilities.
var assert = require('assert')

// Return the first not null-like value.
var coalesce = require('extant')

// Ever increasing serial value with no maximum value.
var Monotonic = require('monotonic').asString

// A timer with named, cancelable events.
var Scheduler = require('happenstance').Scheduler

// An evented message queue used for the atomic log.
var Procession = require('procession')
var Window = require('procession/window')

// A sorted index into the atomic log. TODO Must it be a tree?
var Indexer = require('procession/indexer')

// Logging conduit.
var logger = require('prolific.logger').createLogger('paxos')

var Assembly = require('./assembly')
var Proposer = require('./proposer')
var Acceptor = require('./acceptor')

var Shaper = require('./shaper')
var Writer = require('./writer')
var Recorder = require('./recorder')

var Pinger = require('./pinger')

function Paxos (now, republic, id, options) {
    // Uniquely identify ourselves relative to the other participants.
    this.id = String(id)

    // Use the create time as a cookie to identify this instance of this id.
    this.cookie = now

    // A republic identifies a paritcular instance of the Paxos algorithm.
    this.republic = republic

    // Maybe start out naturalized if no futher updates necessary.
    this.naturalized = !! options.naturalized

    this.parliamentSize = coalesce(options.parliamentSize, 5)

    // The atomic log is a linked list. When head of the list is advanced the
    // entries in the list go out of scope and can be collected by the garbage
    // collector. We advance the head of the list when we are certain that all
    // participants have received a copy of the entry and added it to their
    // logs. Note that outstanding user iterators prevent this garbage
    // collection, but when we advance the head the entries are dead to us.
    this.log = new Window
    this.log.addListener(this.indexer = new Indexer(function (left, right) {
        assert(left && right)
        assert(left.body && right.body)
        return Monotonic.compare(left.body.promise, right.body.promise)
    }))

    // Implements a calendar for events that we can check during runtime or
    // ignore during debugging playback.
    this.scheduler = new Scheduler

    // This is the right data structure for the job. It is an array of proposals
    // that can have at most one proposals for a new government, where that
    // proposal is unshifted into the array and all the subsequent proposals
    // have their promises remapped to the new government.
    //
    // Returning to this, I felt that it made no sense, just push the new
    // governent onto the end of the array, but then you're moving toward scan
    // the array for an existing government to assert that it is not there, or
    // else queuing governments based on either the current government, or the
    // last future government pushed onto the proposal array.
    //
    // Although it's not multi-dimensional, I see this structure in my mind as
    // somehow ether dash shapped, an array of just proposals, or L shaped an
    // array of proposals with a new government unshifted.
    //
    // Sometimes there's a scout leader, and sometimes there's not.
    //
    // But, the array is the correct structure. It makes the remapping easy.
    //
    // Governments jumping the gun is the right way to go, and here's how we
    // prioritize them, by constantly unshifting only the next one onto the
    // array.
    //
    // This means that there is a queue of awaiting governments. It is, however,
    // implicit. We will review our current government when we create a new one,
    // and when a ping changes the reachable state of a constituent. Recall that
    // a new government is formed to immigrate or exile a citizen.
    //
    this.proposals = []
    this.immigrating = []
    // TODO OUTGOING.
    this.collapsed = false

    this.government = {
        promise: '0/0',
        minority: [],
        majority: [],
        properties: {},
        immigrated: { id: {}, promise: {} }
    }

    this._promises = { active: '0/0', issued: null }

    this.lastIssued = null
    this.promise = '0/0'

// TODO Randomly adjust election retry by a percentage. Randomly half or
// randomly half as much again.

    this.ping = coalesce(options.ping, 1000)
    this.timeout = coalesce(options.timeout, 5000)

    this.constituency = []
    this.citizens = []

    this.minimum = '0/0'

    this.outbox = new Procession

    this._pinger = new Pinger(null, this.timeout)

//    this.least = this.log.shifter()

    // TODO So, does it matter if the user nevers sees `0/0`?
    this.log.push({
        module: 'paxos',
        promise: '0/0',
        body: this.government
    })

    this._writer = new Writer(this, '1/0')
    this._recorder = new Recorder(this, '1/0')
}

// We are only ever supposed to call `newGovernment` when we are not in the
// process of forming a new government. There is only ever supposed to be one in
// process or in the queue. You'll notice that we call `newGovernment` during
// bootstrap, during consensus selection and during collapse. Many decisions
// about the new goverment are based on the current government, so we can't have
// them queued up, unless we want to also maintain the latest version of the
// government we hope to have someday, which offends my pragmatic sensibilities.

//
Paxos.prototype.newGovernment = function (now, quorum, government, promise) {
    assert(!government.constituents)
    promise = Monotonic.increment(this.promise, 0)
    government.constituents = Object.keys(this.government.properties).sort().filter(function (citizen) {
        return !~government.majority.indexOf(citizen)
            && !~government.minority.indexOf(citizen)
    })
    var remapped = government.promise = promise, map = {}
    this.proposals = this.proposals.splice(0, this.proposals.length).map(function (proposal) {
        proposal.was = proposal.promise
        proposal.route = government.majority
        proposal.promise = remapped = Monotonic.increment(remapped, 1)
        map[proposal.was] = proposal.promise
        return proposal
    })
    this.lastIssued = remapped
    var properties = JSON.parse(JSON.stringify(this.government.properties))
    var immigrated = JSON.parse(JSON.stringify(this.government.immigrated))
// TODO I'd rather have a more intelligent structure.
    if (government.immigrate) {
        var immigrate = government.immigrate
        properties[immigrate.id] = JSON.parse(JSON.stringify(government.immigrate.properties))
        government.constituents.push(immigrate.id)
        immigrated.promise[immigrate.id] = promise
        immigrated.id[promise] = immigrate.id
    } else if (government.exile) {
        var exile = government.exile
        exile.promise = immigrated.promise[exile.id]
        exile.properties = properties[exile.id]
        delete immigrated.promise[exile.id]
        delete immigrated.id[exile.promise]
        delete properties[exile.id]
        government.constituents.splice(government.constituents.indexOf(exile.id), 1)
    }
// TODO Null map to indicate collapse or change in leadership. Wait, change in
// leader is only ever collapse? Ergo...
    government.map = this._writer.collapsed ? null : map
    government.immigrated = immigrated
    government.properties = properties
    assert(this.proposals.length == 0 || !Monotonic.isBoundary(this.proposals[0].promise, 0))
    this._writer.unshift({ promise: promise, quorum: quorum, body: government })
    this._writer.nudge()
}

// Find a round of paxos in the log based on the given promise.
//
// Not loving how deeply nested these conditions and keys are, but I understand
// why it is that way, and it would be a full wrapper of `bintrees` to fix it.

//
Paxos.prototype._findRound = function (sought) {
    return this.indexer.tree.find({ body: { promise: sought } })
}

Paxos.prototype._nudgeRedux = function (now) {
    if (this.immigrating.length != 0) {
        var immigration = this.immigrating[0]
        this.newGovernment(now, this.government.majority, {
            majority: this.government.majority,
            minority: this.government.minority,
            immigrate: {
                id: immigration.id,
                properties: immigration.properties,
                cookie: immigration.cookie
            }
        })
    }
}

Paxos.prototype._stuffSynchronize = function (pings, sync, count) {
    var ping = pings[0]
    for (var i = 1, I = pings.length; i < I; i++) {
        assert(ping.committed != null && pings[i].committed != null)
        if (Monotonic.compare(pings[i].committed, ping.committed) < 0) {
            ping = pings[i]
        }
        assert(ping.committed != '0/0')
    }
    var iterator
    if (ping.committed == null) {
        return true
    } else if (ping.committed == '0/0') {
        iterator = this.log.trailer.node.next
        for (;;) {
// TODO This will abend if the naturalization falls off the end end of the log.
// You need to check for gaps and missing naturalizations and then timeout the
// constituents that will never be connected.
            if (iterator == null) {
                return false
            }
            // assert(round, 'cannot find immigration')
            if (Monotonic.isBoundary(iterator.body.promise, 0)) {
                var immigrate = iterator.body.body.immigrate
                if (immigrate && immigrate.id == ping.id) {
                    break
                }
            }
            iterator = iterator.next
        }
    } else {
        // If our minimum promise is greater than the most decided promise for
        // the contituent then our ping record for the constituent is out of
        // date.
        if (Monotonic.compare(ping.committed, this.minimum) < 0) {
            return false
        }

// TODO Got a read property of null here.
        iterator = this._findRound(ping.committed).next
    }

    while (--count && iterator != null) {
        sync.commits.push({
            promise: iterator.body.promise,
            body: iterator.body.body,
            previous: null
        })
        iterator = iterator.next
    }

    return true
}

Paxos.prototype._prepare = function (now, request, sync) {
    this._recorder = new Acceptor(this)
    return this._recorder.request(now, request, sync)
}

Paxos.prototype._collapse = function (now) {
    this.scheduler.clear()

    this._writer = new Proposer(this, this.promise)
    this._pinger = new Pinger(this, new Assembly(this.government, this.id))
    this._pinger.update(now, this.id, {
        naturalized: this.naturalized,
        committed: this.log.head.body.promise
    })

    this.proposals.length = 0

    // TODO This is fine. Realize that immigration is a special type of
    // somethign that is built on top of proposals. Ah, or maybe assembly is the
    // shaper and a shaper creates the next shaper. Thus, shaper is the
    // abstraction that is above writer/recorder. Also, Assembly could be called
    // something else, gatherer or collector or roll call or sergent at arms.

    this.immigrating.length = 0

    this.government.majority.concat(this.government.minority)
        .filter(function (id) {
            return id != this.id
        }.bind(this)).forEach(function (id) {
            this.scheduler.schedule(now, id, {
                module: 'paxos',
                method: 'ping',
                body: { method: 'collpase' }
            })
        }, this)
}

// Determine the minimum log entry promise.
//
// You might feel a need to guard this so that only the leader runs it, but it
// works of anyone runs it. If they have a ping for every citizen, they'll
// calculate a minimum less than or equal to the minimum calculated by the
// actual leader. If not they do not have a ping record for every citizen,
// they'll continue to use their current minimum.
//
// Would rather this was on object that was updated only when we got ping
// information back.

//
Paxos.prototype._minimize = function () {
    var minimum = this.getPing(this.id).committed
    for (var i = 0, citizen; (citizen = this.citizens[i]) != null; i++) {
        var ping = this.pings[citizen]
        if (ping == null) {
            return
        }
        if (Monotonic.compare(ping.committed, minimum) < 0) {
            minimum = ping.comitted
        }
    }
    this.minimum = minimum
}

Paxos.prototype.event = function (envelope) {
    if (envelope.module != 'happenstance' || envelope.method != 'event') {
        return
    }
    var now = envelope.now
    switch (envelope.body.method) {
    case 'ping':
        this._send({
            method: 'synchronize',
            to: [ envelope.key ],
            sync: null
        })
        break
    case 'keepAlive':
        this._send({
            method: 'synchronize',
            to: this.government.majority,
            sync: null
        })
        break
    case 'collapse':
        this._collapse(envelope.now)
        break
    }
}

Paxos.prototype._send = function (request) {
    request.sync = {
        from: this.id,
        minimum: this.minimum,
        committed: this.log.head.body.promise,
        cookie: this.cookie,
        commits: []
    }
    var pings = []
    for (var i = 0, to; (to = request.to[i]) != null; i++) {
        pings.push(this._pinger.getPing(to))
    }
    this._stuffSynchronize(pings, request.sync, 20)
    this.outbox.push(request)
}

Paxos.prototype.bootstrap = function (now, properties) {
    // Update current state as if we're already leader.
    this.naturalize()

    var government = {
        promise: '1/0',
        majority: [ this.id ],
        minority: [],
        constituents: [],
        map: {},
        immigrate: { id: '0', properties: { location: '0' }, cookie: 0 },
        properties: {},
        immigrated: { promise: {}, id: {} }
    }

    this.immigrating.push({ id: this.id })

    government.properties[this.id] = properties
    government.immigrated.promise[this.id] = '1/0'
    government.immigrated.id['1/0'] = this.id

    this._receiveEnact(now, {}, { promise: '1/0', body: government })
}

Paxos.prototype.naturalize = function () {
    this.naturalized = true
}

// TODO Is all this checking necessary? Is it necessary to return the island id
// and leader? This imagines that the client is going to do the retry, but in
// reality we often have the cluster performt the retry. The client needs to
// talk to a server that can be discovered, it can't use the Paxos algorithm for
// address resolution. From the suggested logic, it will only have a single
// address, and maybe be told of an actual leader. What happens when that
// address is lost? Don't see where returning `republic` and leader helps at
// all. It is enough to say you failed, backoff and try again. The network layer
// can perform checks to see if the recepient is the leader and hop to the
// actual leader if it isn't, reject if it is but collapsed.
//
// Once you've externalized this in kibitz, remove it, or pare it down.
Paxos.prototype._enqueuable = function (republic) {
    if (this._writer.collapsed || this.republic != republic) {
        return {
            enqueued: false,
            republic: this.republic,
            leader: null
        }
    }
    if (this.government.majority[0] != this.id) {
        return {
            enqueued: false,
            republic: this.republic,
            leader: this.government.majority[0]
        }
    }
}

// Note that a client will have to treat a network failure on submission as a
// failure requiring boundary detection.
Paxos.prototype.enqueue = function (now, republic, message) {

    var response = this._enqueuable(republic)
    if (response == null) {
// TODO Bombs out the current working promise.
        // TODO Note that we used to snapshot the majority here as the route but
        // that can change. Note that the last issued promise is not driven by
        // government enactment, it is incremented as we greate new promises and
        // governments.
        var promise = this.lastIssued = Monotonic.increment(this.lastIssued, 1)
        this.proposals.push({
            promise: promise,
            route: null,
            //route: this.government.majority,
            body: message
        })
        this._nudge(now)

        response = {
            enqueued: true,
            leader: this.government.majority[0],
            promise: promise
        }
    }

    return response
}

// TODO This is a note. I'd like to find a place to journal this. I'm continuing
// to take measures to allow for the reuse of ids. It still feels right to me
// that a display of government or of the census would be displayed using values
// meaningful to our dear user; Kubernetes HOSTNAMES, AWS instance names, IP
// address, and not something that is garunteed unique like a UUID, because such
// things are indistinguishable to the human observer.
//
// Yet, here I am again contending with an issue that would be so simple if ids
// where required to be unique. When a citizen that is a constituent dies and
// restarts with the same id it will be pinged by someone in government, it will
// report that it's empty, and its representative will look for it's immigration
// record. There's a race now. Is the new instance going to immigrate before its
// pinged? Or is the representative going to search for an immigration record
// and not find one, which causes us to abend at the moment?
//
// When we get a sync before immigration, it will not see a cookie or not see
// the right cookie and fail the sync. These syncs fail, time passes, the time
// out comes and the record is cleared. That takes care of the race when the
// sync beats the immigration record, but what if the immigration record beats
// the representative?
//
// In that case their will be a new government with the same represenative with
// the same consitutent, but now there will be an immigration record. The
// consituent will be naturalized. It will never have been exiled.
//
// This is a problem. Implementations are going to need to know that they've
// restarted. A participant should be exiled before it can immigrate again.
//
// Obviously, much easier if the ids are unique. Whole new id means not
// ambiguity. The new id immigrates, the old id exiles. (Unique ids are easy
// enough to foist upon our dear user implementation wise. Most implementations
// reset a process or at least an object, and that new instance can have a new
// id generated from POSIX time or UUID.)
//
// However, we do have an atomic log at our disposal, so every time I think that
// I should give up and go with unique ids, something comes along to make it
// simple. I was actually musing about how the client, if they really wanted
// pretty ids, they could just check and wait for the old id to exile, since it
// only needs to be unique in the set of current ids. Then, duh, I can do that
// same check on immigration and reject the immigration if the id already exists
// in the census.
//
// That's what you're looking at here.
//
// Now that that is done, though, is there a race condition where the
// immigration is currently being proposed? The property wouldn't be removed
// until the proposal was enacted.

//
Paxos.prototype.immigrate = function (now, republic, id, cookie, properties) {
    var response = this._enqueuable(republic)
    if (response == null) {
        // Do not allow the user to initiate the immigration of an id that
        // already exists. This will happen if a denizen crash restarts and
        // tries to rejoin before Paxos can determine that the denizen is no
        // longer viable. The immigrating denizen should enter a back off and
        // retry loop in order to wait for exile.
        if (id in this.government.properties) {
            response = {
                enqueued: false,
                republic: this.republic,
                leader: this.government.majority[0]
            }
        } else {
            // TODO However, are we checking that we're not proposing the same immigration
            // twice if it added to the `immigrating` array while it is being proposed?
            //
            // No, this is a race condition.
            //
            // We could be in the middle of immigrating when the immigrant crash restarts
            // and submits a new cookie. That immigrant will never sync or naturalize. It
            // needs to try again.
            //
            // We can make it a general case that if the cookies mismatch
            // every one is very disappointed. Thus, we can catch this on sync.
            for (var i = 0, immigrant; (immigrant = this.immigrating[i]) != null; i++) {
                if (immigrant.id == id) {
                    break
                }
            }
            if (i == this.immigrating.length) {
                this.immigrating.push({
                    type: 'immigrate',
                    id: id,
                    properties: properties,
                    cookie: cookie
                })
            } else {
                this.immigrating[i].properties = properties
                this.immigrating[i].cookie = cookie
            }
            response = { enqueued: true }

            this._nudgeRedux(now)
        }
    }

    return response
}

// TODO Note that minimum only ever goes up so a delayed minimum is not going to
// ever be invalid. We don't want to run it in case it rejects our start.

//
Paxos.prototype.request = function (now, request) {
    var sync = {
        from: this.id,
        naturalized: this.naturalized,
        minimum: this.minimum,
        committed: this.log.head.body.promise,
        cookie: this.cookie,
        commits: []
    }

    if (Monotonic.compare(request.sync.committed, sync.committed) < 0) {
        // We are ahead of the bozo trying to update us, so update him back.
        this._stuffSynchronize(now, sync, sync, 20)
        return { method: 'reject', promise: sync.committed, sync: sync }
    }

    // Sync.
    for (var i = 0, commit; (commit = request.sync.commits[i]) != null; i++) {
        this._commit(now, commit)
    }

    // We don't want to advance the minimum if we have no items yet.
    if (this.log.head.body.body.promise != '0/0') {
        while (Monotonic.compare(this.log.trailer.peek().promise, request.sync.minimum) < 0) {
            this.log.trailer.shift()
        }
        if (Monotonic.compare(this.minimum, request.sync.minimum) < 0) {
            this.minimum = request.sync.minimum
        }
    }

    if (request.method == 'synchronize') {
        return { sync: sync }
    } else {
        return this._recorder.request(now, request, sync)
    }
}

Paxos.prototype.response = function (now, request, responses) {
    // If anyone we tried to update is ahead of us, we learn from them.
    for (var i = 0, I = request.to.length; i < I; i++) {
        var response = responses[request.to[i]]
        if (response == null) {
            responses[request.to[i]] = { sync: { committed: '0/0' } }
            this._pinger.update(now, request.to[i], null)
        } else {
            this._pinger.update(now, request.to[i], response.sync)
            for (var j = 0, commit; (commit = response.sync.commits[j]) != null; i++) {
                this._commit(commit)
            }
        }
    }
    // TODO Probably run every time, probably always fails.
    if (request.method == 'synchronize') {
        var delay = this.log.head.body.promise == responses[request.to[0]].sync.committed
                  ? now + this.ping
                  : now
        if (this.constituency.length == 0) {
            this.scheduler.schedule(delay, request.to[0], {
                module: 'paxos',
                method: 'keepAlive',
                body: null
            })
        } else {
            this.scheduler.schedule(delay, request.to[0], {
                module: 'paxos',
                method: 'ping',
                body: null
            })
        }
        return
    }
    // Only handle a response if it was issued by our current writer/proposer.
    if (request.version[0] == this._writer.version[0] && request.version[1] == this._writer.version[1]) {
        var promise = '0/0', failed = false
        for (var id in responses) {
            if (responses[id] == null) {
                failed = true
            } else {
                if (Monotonic.compare(promise, responses[id].promise) < 0) {
                    promise = responses[id].promise
                }
                if (responses[id].method == 'reject') {
                    failed = true
                }
            }
        }
        this._writer.response(now, request, responses, failed ? promise : null)
    }
}

Paxos.prototype._commit = function (now, entry) {
    var entries = []
    while (entry) {
        entries.push({ promise: entry.promise, body: entry.body })
        entry = entry.previous
    }

    for (var i = 0, entry; (entry = entries[i]) != null; i++) {
        this._receiveEnact(now, {}, entry)
    }
}

Paxos.prototype._receiveEnact = function (now, pulse, message) {
    message = JSON.parse(JSON.stringify(message))
    logger.info('_receiveEnact', { now: now, $route: pulse.route, $message: message })

    var max = this.log.head.body

    // TODO Since we only ever increment by one, this could be more assertive
    // for the message number. However, I have to stop and recall whether we
    // skip values for the government number, and I'm pretty sure we do.
    //
    // TODO This implies that we can be very certain about a sync if we ensure
    // that there are no gaps in both the government series and the message
    // series, which could be done by backfilling any gaps encountered during
    // failed rounds of Paxos.

    //
    var valid = Monotonic.compare(max.promise, message.promise) < 0

    // TODO Simply skip if it is bad, but now I'm considering failing because it
    // indicates something wrong on the part of the sender, but then the sender
    // will fail, so it will timeout and try to ping again. When it does it will
    // assume that it has correct values for `decided`.

    // Okay, we're not always going to get just the entries we're missing. An
    // election can seek to bring a minority member up to date by pushing it an
    // enactment before a proposal. The message bundle will be received by all
    // members of the proposed government, including the leader that is doing
    // the pushing, so it's log will have, of course, already enacted the
    // member -- it pulled the enactment of of it's own log after all.

    //
    if (!valid) {
        // tentative -> pulse.failed = true
        return
    }

    valid = max.promise != '0/0'

    if (!valid) {
        // assert(this.log.size == 1)
        valid = Monotonic.isBoundary(message.promise, 0)
        valid = valid && this.log.trailer.peek().promise == '0/0'
        valid = valid && message.body.immigrate
        valid = valid && message.body.immigrate.id == this.id
        valid = valid && message.body.immigrate.cookie == this.cookie
    }

    if (!valid) {
        // TODO We can see failure when the returned max is still 0/0.
        pulse.failed = true
        return
    }

    this.proposal = null
    this.accepted = null
    this.collapsed = false

    var isGovernment = Monotonic.isBoundary(message.promise, 0)
    logger.info('enact', {
        outOfOrder: !(isGovernment || Monotonic.increment(max.promise, 1) == message.promise),
        isGovernment: isGovernment,
        previous: max.promise,
        next: message.promise
    })

// TODO How crufy are these log entries? What else is lying around in them?
    max.next = message
    message.previous = max.promise
// Forever bombing out our latest promise.
    this.promise = message.promise

    if (isGovernment) {
        this._enactGovernment(now, message)
    }

    var pinger = new Pinger(this, new Shaper(this.parliamentSize, this.government))

    pinger.ingest(now, this._pinger, this.constituency)

    this._pinger = pinger

    this._pinger.update(now, this.id, { naturalized: this.naturalized, committed: message.promise })

    this.log.push({
        module: 'paxos',
        method: isGovernment ? 'government' : 'entry',
        promise: message.promise,
        previous: max.promise,
        body: message.body
    })

    for (var i = 0, id; (id = this.constituency[i]) != null; i++) {
        this.scheduler.schedule(now, id, { module: 'paxos', method: 'ping', body: null })
    }
}

// Majority updates minority. Minority updates constituents. If there is
// no minority, then the majority updates constituents.

//
Paxos.prototype._determineConstituency = function () {
    this.constituency = []
    var parliament = this.government.majority.concat(this.government.minority)
    if (parliament.length == 1) {
        if (this.id == this.government.majority[0]) {
            this.constituency = this.government.constituents.slice()
        }
    } else {
        var index = this.government.majority.slice(1).indexOf(this.id)
        if (~index) {
            var length = this.government.majority.length - 1
            var population = this.government.minority.length
                           ? this.government.minority
                           : this.government.constituents
            this.constituency = population.filter(function (id, i) {
                return i % length == index
            })
        } else if (~(index = this.government.minority.indexOf(this.id))) {
            var length = this.government.minority.length
            this.constituency = this.government.constituents.filter(function (id, i) {
                return i % length == index
            })
        }
    }
}

Paxos.prototype._enactGovernment = function (now, round) {
    this.scheduler.clear()

    assert(Monotonic.compare(this.government.promise, round.promise) < 0, 'governments out of order')

    this.government = JSON.parse(JSON.stringify(round.body))

    this._writer = this._writer.createWriter(round.promise)
    this._recorder = this._recorder.createRecorder()

    if (this.government.exile) {
        // TODO Remove! Fall back to a peek at exile.
        delete this.pings[this.government.exile.id]
    } else if (this.government.immigrate && this.government.majority[0] == this.id) {
        assert(this.immigrating.length > 0 && this.government.immigrate.id == this.immigrating[0].id)
        this.immigrating.shift()
    }

    if (this.id != this.government.majority[0]) {
        this.proposals.length = 0
    }

// TODO Decide on whether this is calculated here or as needed.
    this.parliament = this.government.majority.concat(this.government.minority)

    this._determineConstituency()
    assert(!this.constituency.length || this.constituency[0] != null)
    this.scheduler.clear()
    if (this.government.majority[0] == this.id && this.government.majority.length != 1) {
        this.scheduler.schedule(now + this.ping, this.id, {
            module: 'paxos',
            method: 'keepAlive',
            body: null
        })
    } else if (~this.government.majority.slice(1).indexOf(this.id)) {
        this.scheduler.schedule(now + this.timeout, this.id, {
            module: 'paxos',
            method: 'collapse',
            body: null
        })
    }

    // Reset ping tracking information. Leader behavior is different from other
    // members. We clear out all ping information for ping who are not our
    // immediate constituents. This will keep us from hoarding stale ping
    // records. When everyone performs this cleaning, we can then trust
    // ourselves to return all ping information we've gathered to anyone that
    // pings us, knowing that it is all flowing from minority members to the
    // leader. We do not have to version the records, timestamp them, etc.
    //
    // If we didn't clear them out, then a stale record for a citizen can be
    // held onto by a majority member. If the minority member that pings the
    // citizen is no longer downstream from the majority member, that stale
    // record will not get updated, but it will be reported to the leader.
    //
    // We keep ping information if we are the leader, since it all flows back to
    // the leader. All leader information will soon be updated. Not resetting
    // the leader during normal operation makes adjustments to citizenship go
    // faster.
    this.citizens = this.government.majority
                        .concat(this.government.minority)
                        .concat(this.government.constituents)
}

module.exports = Paxos
