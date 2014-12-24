var assert = require('assert')
var push = [].push
var serializer = require('../serializer')

function Machine (network, legislator) {
    this.network = network
    this.legislator = legislator
}

Machine.prototype.receive = function (route, index, envelopes) {
    var expanded = serializer.expand(envelopes)
    this.legislator.ingest(expanded)

    var route = this.legislator.routeOf(route.path)

    if (index + 1 < route.path.length) {
        var forwards = this.legislator.forwards(route.path, index)
        this.legislator.ingest(this.network.post(route, index + 1, forwards))
    }

    return this.legislator.returns(route.path, index)
}

Machine.prototype.tick = function () {
    var ticked = false

    var route = this.legislator.route() || this.legislator.unroute()

    if (route && route.path.length > 1) {
        var forwards = this.legislator.forwards(route.path, 0)
        if (forwards.length) {
            ticked = true
            this.legislator.ingest(this.network.post(route, 1, forwards))
        }
    }

    return ticked
}

module.exports = Machine
