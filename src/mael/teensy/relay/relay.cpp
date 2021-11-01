// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see https://www.gnu.org/licenses/.

#include "config.hh"
#include <Arduino.h>
#include <SPI.h>
#include <RF24.h>

static RF24 radio(PIN_RF24_CE, PIN_RF24_CSN);

static void InitRadio()
{
    while (!radio.begin(&SPI)) {
        Serial.println("Radio hardware not responding!!");
        delay(2000);
    }

    radio.setPALevel(RF24_PA_LOW);
    radio.setPayloadSize(32);

    radio.openWritingPipe(RF24_ADDR2);
    radio.openReadingPipe(1, RF24_ADDR1);

    radio.startListening();
}

void setup()
{
    Serial.begin(9600);

    SPI.begin();
    InitRadio();
}

void loop()
{
    if (radio.failureDetected) {
        radio.failureDetected = false;
        Serial.println("Radio failure detected, restarting radio");

        delay(250);
        InitRadio();
    }

    while (radio.available()) {
        uint8_t buf[32];
        radio.read(buf, 32);

        if (buf[0] <= 31) {
            Serial.write(buf + 1, buf[0]);
        }
    }
}