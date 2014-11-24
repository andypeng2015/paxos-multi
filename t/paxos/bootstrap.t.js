
require('proof')(4, prove)

function prove (assert) {
    var Legislator = require('../../legislator'),
        Network = require('../../synchronous/network'),
        Machine = require('../../synchronous/machine')

    var legislators = [ new Legislator(0) ]
    legislators[0].bootstrap()

    function logger (count, id, message) {
        console.log(count, id, message)
    }

    var network = new Network
    var machine = new Machine(network, legislators[0], logger)
    network.machines.push(machine)

    // Legislator.synchronous(legislators, 0, logger)

    machine.tick()

    assert(legislators[0].government, {
        id: '1/0', leader: 0, majority: [ 0 ], members: [ 0 ], interim: false
    }, 'bootstrap')

    network.machines.push(new Machine(network, new Legislator(1), logger))

    network.machines[1].legislator.sync([ 0 ], 20)
    network.machines[1].tick()

    assert(network.machines[1].legislator.government, {
        id: '1/0', leader: 0, majority: [ 0 ], members: [ 0 ], interim: false
    }, 'synchronize join')

    // todo: yes, you look inside the response. it is not opaque. you are at
    // this low level when you are trying to create an interface to an algorithm
    // that is uncommon and subtle.
    var cookie = network.machines[1].legislator.naturalize()
    assert(cookie, 1, 'cookie')
    network.machines[1].tick()
    network.machines[0].tick()
    network.machines[0].tick()
    network.machines[0].tick()
    network.machines[0].tick()

    assert(legislators[0].government, {
        id: '2/0', leader: 0, majority: [ 0, 1 ], members: [ 0, 1 ], interim: false
    }, 'grow')

    return

    assert(legislators[1].government, {
        id: '2/0', leader: 0, majority: [ 0, 1 ], members: [ 0, 1 ], interim: false
    }, 'cleanup pulse')

//    messages = legislators[1].sync([ 0 ], 20)
//    Legislator.synchronous(legislators, 1, messages, logger)
}
