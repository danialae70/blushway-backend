// The small object drivers see for a new ride request
exports.rideCard = (ride, passenger) => ({
  id: String(ride._id),
  rideId: String(ride._id),
  passenger: passenger || 'Passenger',
  pickup: ride.pickup && ride.pickup.address,
  dropoff: ride.destination && ride.destination.address,
  fare: `Rs ${ride.fare}`,
  distance: `${ride.distanceKm} km`,
  estTime: `${ride.durationMin} min`,
});
