// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {BlackjackEngineLib} from "../../games/blackjack/libraries/BlackjackEngineLib.sol";

/// @dev Exposes the pure replay so the golden vectors can be asserted without a full platform deploy.
contract BlackjackEngineHarness {
    function play(
        bytes32 seed,
        BlackjackEngineLib.Input calldata input,
        bytes calldata actions
    ) external pure returns (BlackjackEngineLib.Result memory) {
        return BlackjackEngineLib.play(seed, input, actions);
    }

    function draw(bytes32 seed, uint16 count) external pure returns (uint8[] memory cards) {
        BlackjackEngineLib.Shoe memory shoe = BlackjackEngineLib.newShoe(seed);
        cards = new uint8[](count);
        for (uint16 i = 0; i < count; i++) cards[i] = BlackjackEngineLib.draw(shoe);
    }
}
